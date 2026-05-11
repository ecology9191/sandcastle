import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getNextStepsLines,
  listAgents,
  getAgent,
  listTemplates,
  listBacklogManagers,
  getBacklogManager,
  listSandboxProviders,
  getSandboxProvider,
} from "./InitService.js";
import type { AgentEntry, ScaffoldOptions } from "./InitService.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { SKELETON_PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));
const execFile = promisify(execFileCallback);

const claudeCodeAgent = getAgent("claude-code")!;
const piAgent = getAgent("pi")!;
const codexAgent = getAgent("codex")!;
const opencodeAgent = getAgent("opencode")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-6",
};

const BEADS_CLOSE_COMMAND =
  'bd close <ID> --reason "Completed by Sandcastle" --json';
const BEADS_VIEW_COMMAND = "bd show <ID> --json && bd comments <ID> --json";

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

type WorkflowCall =
  | { type: "human-gates" }
  | { type: "task-context"; taskId: string }
  | { type: "run"; name?: string; promptArgs?: Record<string, string> }
  | { type: "createSandbox"; branch?: string }
  | { type: "sandbox.close" };

const workflowBacklogManager = (
  contextScriptPath: string,
  humanGatesScriptPath: string,
) => ({
  name: "test-backlog",
  label: "Test backlog",
  templateArgs: {
    LIST_TASKS_COMMAND: "test list tasks",
    VIEW_TASK_COMMAND: `${process.execPath} ${contextScriptPath} <ID>`,
    CLOSE_TASK_COMMAND: "test close <ID>",
    HUMAN_GATES_COMMAND: `${process.execPath} ${humanGatesScriptPath}`,
    BACKLOG_MANAGER_TOOLS: "",
  },
  envExample: "",
});

const writeWorkflowHarness = async (
  repoDir: string,
  options?: {
    contextOutput?: "value" | "empty";
    humanGateOutput?: "empty" | "present";
  },
) => {
  const callsPath = join(repoDir, "calls.json");
  const contextScriptPath = join(repoDir, "task-context.mjs");
  const humanGatesScriptPath = join(repoDir, "human-gates.mjs");
  await writeFile(callsPath, "[]");
  await writeFile(
    contextScriptPath,
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";

const callsPath = process.env.SANDCASTLE_TEST_CALLS_PATH;
const taskId = process.argv[2];
const calls = existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, "utf-8")) : [];
calls.push({ type: "task-context", taskId });
writeFileSync(callsPath, JSON.stringify(calls));

if (process.env.SANDCASTLE_TEST_CONTEXT_OUTPUT === "empty") {
  process.exit(0);
}

console.log(JSON.stringify({ id: taskId, body: "authoritative context for " + taskId }));
`,
  );
  await writeFile(
    humanGatesScriptPath,
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";

const callsPath = process.env.SANDCASTLE_TEST_CALLS_PATH;
const calls = existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, "utf-8")) : [];
calls.push({ type: "human-gates" });
writeFileSync(callsPath, JSON.stringify(calls));

if (process.env.SANDCASTLE_TEST_HUMAN_GATES === "present") {
  console.log(JSON.stringify([{ id: "TASK-HITL", title: "Approve shell", status: "deferred", defer_until: "2099-01-01T00:00:00Z" }]));
} else {
  console.log("[]");
}
`,
  );

  const packageDir = join(repoDir, "node_modules", "@ecology91", "sandcastle");
  await mkdir(join(packageDir, "sandboxes"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      type: "module",
      exports: {
        ".": "./index.js",
        "./sandboxes/docker": "./sandboxes/docker.js",
      },
    }),
  );
  await writeFile(
    join(packageDir, "sandboxes", "docker.js"),
    `export const docker = () => ({ type: "docker" });
`,
  );
  await writeFile(
    join(packageDir, "index.js"),
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";

let plannerCalls = 0;

const callsPath = () => process.env.SANDCASTLE_TEST_CALLS_PATH;
const push = (entry) => {
  const path = callsPath();
  const calls = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
  calls.push(entry);
  writeFileSync(path, JSON.stringify(calls));
};

export const claudeCode = (model) => ({ model });

const planFor = () => {
  plannerCalls += 1;
  if (plannerCalls > 1) {
    return '<plan>{"issues":[]}</plan>';
  }
  return '<plan>{"issues":[{"id":"TASK-1","title":"Hydrate context","branch":"agent/task-1"}]}</plan>';
};

export const run = async (options) => {
  push({ type: "run", name: options.name, promptArgs: options.promptArgs });
  if (options.name === "planner") {
    return { stdout: planFor(), commits: [], branch: "planner" };
  }
  if (options.name === "implementer") {
    return {
      stdout: "<promise>COMPLETE</promise>",
      completionSignal: "<promise>COMPLETE</promise>",
      commits: [{ sha: "abc123" }],
      branch: options.branchStrategy?.branch,
    };
  }
  return {
    stdout: "<promise>COMPLETE</promise>",
    completionSignal: "<promise>COMPLETE</promise>",
    commits: [],
    branch: "main",
  };
};

export const createSandbox = async (options) => {
  push({ type: "createSandbox", branch: options.branch });
  return {
    run: async (runOptions) => run(runOptions),
    close: async () => push({ type: "sandbox.close" }),
  };
};
`,
  );

  return {
    callsPath,
    contextScriptPath,
    humanGatesScriptPath,
    contextOutput: options?.contextOutput ?? "value",
    humanGateOutput: options?.humanGateOutput ?? "empty",
  };
};

const runGeneratedWorkflow = async (
  repoDir: string,
  harness: Awaited<ReturnType<typeof writeWorkflowHarness>>,
) => {
  const mainPath = join(repoDir, ".sandcastle", "main.mts");
  return execFile(process.execPath, ["--import", "tsx", mainPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SANDCASTLE_TEST_CALLS_PATH: harness.callsPath,
      SANDCASTLE_TEST_CONTEXT_OUTPUT: harness.contextOutput,
      SANDCASTLE_TEST_HUMAN_GATES: harness.humanGateOutput,
    },
    maxBuffer: 1024 * 1024,
    timeout: 20_000,
  });
};

const readWorkflowCalls = async (callsPath: string): Promise<WorkflowCall[]> =>
  JSON.parse(await readFile(callsPath, "utf-8")) as WorkflowCall[];

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

describe("Agent registry", () => {
  it("listAgents returns at least claude-code", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "claude-code")).toBe(true);
  });

  it("getAgent returns claude-code entry with expected fields", () => {
    const agent = getAgent("claude-code");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("claude-code");
    expect(agent!.defaultModel).toBe("claude-opus-4-6");
    expect(agent!.factoryImport).toBe("claudeCode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
  });

  it("getAgent returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });

  it("listAgents includes pi", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "pi")).toBe(true);
  });

  it("getAgent returns pi entry with expected fields", () => {
    const agent = getAgent("pi");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("pi");
    expect(agent!.defaultModel).toBe("claude-sonnet-4-6");
    expect(agent!.factoryImport).toBe("pi");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain(
      "@mariozechner/pi-coding-agent",
    );
  });

  it("listAgents includes codex", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "codex")).toBe(true);
  });

  it("getAgent returns codex entry with expected fields", () => {
    const agent = getAgent("codex");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("codex");
    expect(agent!.defaultModel).toBe("gpt-5.4-mini");
    expect(agent!.factoryImport).toBe("codex");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("@openai/codex");
  });

  it("listAgents includes opencode", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "opencode")).toBe(true);
  });

  it("getAgent returns opencode entry with expected fields", () => {
    const agent = getAgent("opencode");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("opencode");
    expect(agent!.defaultModel).toBe("opencode/big-pickle");
    expect(agent!.factoryImport).toBe("opencode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("opencode-ai");
  });
});

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

describe("InitService scaffold", () => {
  it("uses agent dockerfileTemplate for Dockerfile (with templateArgs substitution)", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    // Template has {{BACKLOG_MANAGER_TOOLS}} replaced — should contain GitHub CLI (default backlog manager)
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("GitHub CLI");
    expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
  });

  // --- Dynamic .env.example generation ---

  it.each([
    {
      agent: claudeCodeAgent,
      expectedKey: "ANTHROPIC_API_KEY=",
      unexpectedKey: "OPENAI_KEY=",
      expectIssue191Link: true,
    },
    {
      agent: piAgent,
      expectedKey: "ANTHROPIC_API_KEY=",
      unexpectedKey: "OPENAI_KEY=",
      expectIssue191Link: false,
    },
    {
      agent: codexAgent,
      expectedKey: "OPENAI_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectIssue191Link: false,
    },
    {
      agent: opencodeAgent,
      expectedKey: "OPENCODE_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectIssue191Link: false,
    },
  ])(
    "generates .env.example with $agent.name env var",
    async ({ agent, expectedKey, unexpectedKey, expectIssue191Link }) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const envExample = await readFile(
        join(dir, ".sandcastle", ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain(expectedKey);
      expect(envExample).not.toContain(unexpectedKey);
      expect(envExample).toContain("SANDCASTLE_TERMINAL_OUTPUT=");
      expect(envExample).toContain("off|verbose");
      if (expectIssue191Link) {
        expect(envExample).toContain("issues/191");
      } else {
        expect(envExample).not.toContain("issues/191");
      }
    },
  );

  it("generates .env.example with GH_TOKEN when backlog manager is github-issues", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      backlogManager: getBacklogManager("github-issues"),
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("GH_TOKEN=");
  });

  it("does not scaffold env-driven OpenCode variant selection", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: opencodeAgent,
      model: opencodeAgent.defaultModel,
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).not.toContain("OPENCODE_VARIANT=");
    expect(envExample).not.toContain("SANDCASTLE_OPENCODE_VARIANT=");
  });

  it("generates .env.example without GH_TOKEN when backlog manager is beads", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      backlogManager: getBacklogManager("beads"),
    });

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).not.toContain("GH_TOKEN=");
  });

  it("does not scaffold config.json for blank template", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".sandcastle", "config.json")),
    ).rejects.toThrow();
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".sandcastle"));

    await expect(runScaffold(dir)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes .env, logs/, and worktrees/ in .gitignore but not patches/", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain("worktrees/");
    expect(gitignore).not.toContain("patches/");
  });

  it("Dockerfile template contains worktree mount comment", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_REPO_DIR);
  });

  it("claude-code Dockerfile template does not install pnpm or enable corepack", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).not.toContain("pnpm");
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("# ");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("blank template produces skeleton prompt and main.mts", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const configDir = join(dir, ".sandcastle");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
  });

  it("blank template main.mts imports from @ecology91/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@ecology91/sandcastle"');
  });

  it("blank template main.mts calls run()", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
  });

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "blank" });

    const prompt1 = await readFile(
      join(dir1, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt1).toBe(prompt2);
  });

  // --- main file rewriting ---

  it("scaffolds main.mts with the specified model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('claudeCode("claude-sonnet-4-6")');
    // Should not contain the template's original model
    expect(mainTs).not.toContain('claudeCode("claude-opus-4-6")');
  });

  it("scaffolds main.mts with default model when using agent default", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('claudeCode("claude-opus-4-6")');
  });

  // --- Template-specific tests ---

  it("simple-loop template produces main.mts and prompt.md", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const configDir = join(dir, ".sandcastle");
    const { access } = await import("node:fs/promises");

    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("simple-loop main.mts imports from @ecology91/sandcastle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('"@ecology91/sandcastle"');
  });

  it("simple-loop main.mts contains sandcastle.run() with expected options", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("3");
    // When scaffolded with default model, simple-loop uses claude-opus-4-6
    // (rewritten from template's claude-sonnet-4-6)
    expect(mainTs).toContain("promptFile");
    expect(mainTs).toContain("npm install");
    expect(mainTs).toContain("onSandboxReady");
  });

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  describe("sequential-reviewer template", () => {
    it("produces main.mts, implement-prompt.md, and review-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts imports from @ecology91/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ecology91/sandcastle"');
    });

    it("main.mts calls sandcastle.run() twice per iteration (implement + review)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("sandcastle");
      const runCallCount = (mainTs.match(/\.run\(/g) ?? []).length;
      expect(runCallCount).toBeGreaterThanOrEqual(2);
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
    });

    it("main.mts passes branch from implement result to review run", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("branch");
    });

    it("implement-prompt.md contains issue selection and closure, not prompt argument placeholders", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
      expect(prompt).not.toContain("{{ISSUE_TITLE}}");
      expect(prompt).not.toContain("{{BRANCH}}");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("sequential-reviewer appears in listTemplates()", async () => {
      const templates = listTemplates();
      expect(templates.some((t) => t.name === "sequential-reviewer")).toBe(
        true,
      );
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      // Should have guiding comment, not opinionated defaults
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md uses {{SOURCE_BRANCH}} instead of hardcoded main", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{SOURCE_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{SOURCE_BRANCH}}..{{BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });
  });

  it("simple-loop template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, ".sandcastle"));
    const compiledFiles = files.filter(
      (f) =>
        f.endsWith(".js") ||
        f.endsWith(".d.ts") ||
        f.endsWith(".js.map") ||
        f.endsWith(".d.ts.map"),
    );
    expect(compiledFiles).toEqual([]);
  });

  describe("getNextStepsLines", () => {
    it("blank template returns steps mentioning .env and main filename (not npx sandcastle run)", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toContain("main.mts");
      expect(joined).not.toContain("npx sandcastle run");
    });

    it("non-blank template returns steps mentioning .env, package.json scripts, and npm run sandcastle", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain(".env");
      expect(joined).toContain("package.json");
      expect(joined).toContain("npm run sandcastle");
    });

    it("non-blank template includes a note about customizing the install command", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("npm install");
      expect(joined).toContain("onSandboxReady");
    });

    it("non-blank template mentions copyToWorktree and node_modules", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("copyToWorktree");
      expect(joined).toContain("node_modules");
    });

    it("blank template includes a step to customize prompt.md", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt.md");
    });

    it("simple-loop template includes a step to read/customize prompt files", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("sequential-reviewer template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("parallel-planner template includes a step mentioning prompt files", () => {
      const lines = getNextStepsLines("parallel-planner", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("prompt");
      expect(joined).toMatch(/customiz|review|read/i);
    });

    it("returns at least 2 numbered steps for blank template", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(2);
    });

    it("returns at least 3 numbered steps for non-blank templates", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const numberedSteps = lines.filter((l) => /^\d+\./.test(l));
      expect(numberedSteps.length).toBeGreaterThanOrEqual(3);
    });

    it("uses main.ts filename when passed", () => {
      const lines = getNextStepsLines("blank", "main.ts");
      const joined = lines.join("\n");
      expect(joined).toContain("main.ts");
      expect(joined).not.toContain("main.mts");
    });

    it("reviewer template mentions CODING_STANDARDS.md customization", () => {
      const lines = getNextStepsLines("sequential-reviewer", "main.mts");
      const joined = lines.join("\n");
      expect(joined).toContain("CODING_STANDARDS.md");
    });

    it("non-reviewer template does not mention CODING_STANDARDS.md", () => {
      const lines = getNextStepsLines("simple-loop", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });

    it("blank template does not mention CODING_STANDARDS.md", () => {
      const lines = getNextStepsLines("blank", "main.mts");
      const joined = lines.join("\n");
      expect(joined).not.toContain("CODING_STANDARDS.md");
    });
  });

  it("scaffolds pi agent with pi Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
    expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
  });

  it("scaffolds main.mts with pi factory import when pi agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('pi("claude-sonnet-4-6")');
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds codex agent with codex Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
  });

  it("scaffolds opencode Dockerfile with a validated native binary symlink", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: opencodeAgent,
      model: opencodeAgent.defaultModel,
    });

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("npm install -g opencode-ai@latest");
    expect(dockerfile).toContain(
      'ENV OPENCODE_BIN_PATH="/usr/local/bin/opencode-native"',
    );
    expect(dockerfile).toContain(
      'ln -sf "$OPENCODE_NATIVE_BIN" /usr/local/bin/opencode-native',
    );
    expect(dockerfile).toContain("/usr/local/bin/opencode-native --version");
    expect(dockerfile).toContain(
      'find "$(npm root -g)/opencode-ai/node_modules"',
    );
    expect(dockerfile).not.toContain("linux-x64-baseline");
  });

  it("scaffolds opencode Containerfile with native binary setup for podman", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: opencodeAgent,
      model: opencodeAgent.defaultModel,
      sandboxProvider: getSandboxProvider("podman")!,
    });

    const containerfile = await readFile(
      join(dir, ".sandcastle", "Containerfile"),
      "utf-8",
    );
    expect(containerfile).toContain(
      'ENV OPENCODE_BIN_PATH="/usr/local/bin/opencode-native"',
    );
    expect(containerfile).toContain(
      'ln -sf "$OPENCODE_NATIVE_BIN" /usr/local/bin/opencode-native',
    );
    expect(containerfile).toContain("/usr/local/bin/opencode-native --version");
    expect(containerfile).not.toContain("linux-x64-baseline");
  });

  it("scaffolds main.mts with codex factory import when codex agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { agent: codexAgent, model: "gpt-5.4-mini" });

    const mainTs = await readFile(
      join(dir, ".sandcastle", "main.mts"),
      "utf-8",
    );
    expect(mainTs).toContain('codex("gpt-5.4-mini")');
    expect(mainTs).not.toContain("claudeCode");
  });

  // --- createLabel option ---

  it("simple-loop prompt.md retains --label Sandcastle when createLabel is true", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: true });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label Sandcastle");
  });

  it("simple-loop prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop", createLabel: false });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    // The gh issue list command should still be valid
    expect(prompt).toContain("gh issue list");
    // No double spaces in gh commands from removal
    expect(prompt).not.toMatch(/gh issue list {2}/);
  });

  it("parallel-planner plan-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "parallel-planner",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "plan-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("sequential-reviewer implement-prompt.md strips --label Sandcastle when createLabel is false", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "sequential-reviewer",
      createLabel: false,
    });

    const prompt = await readFile(
      join(dir, ".sandcastle", "implement-prompt.md"),
      "utf-8",
    );
    expect(prompt).not.toContain("--label Sandcastle");
    expect(prompt).toContain("gh issue list");
  });

  it("scaffolded prompts that lack a runtime TASK_ID do not contain {{TASK_ID}}", async () => {
    // Regression test for #477: the {{TASK_ID}} placeholder inside
    // VIEW_TASK_COMMAND / CLOSE_TASK_COMMAND used to leak into prompts
    // whose runtime promptArgs do not include TASK_ID (simple-loop,
    // sequential-reviewer's implement, parallel-planner*'s merge),
    // causing PromptArgumentSubstitution to throw on every iteration.
    const cases: Array<{ template: string; file: string }> = [
      { template: "simple-loop", file: "prompt.md" },
      { template: "sequential-reviewer", file: "implement-prompt.md" },
      { template: "parallel-planner", file: "merge-prompt.md" },
      { template: "parallel-planner-with-review", file: "merge-prompt.md" },
    ];
    for (const { template, file } of cases) {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template });
      const prompt = await readFile(join(dir, ".sandcastle", file), "utf-8");
      expect(prompt, `${template}/${file}`).not.toContain("{{TASK_ID}}");
    }
  });

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s injects loaded task context before implementer launch",
    async (templateName) => {
      const dir = await makeDir();
      const harness = await writeWorkflowHarness(dir);
      await runScaffold(dir, {
        templateName,
        backlogManager: workflowBacklogManager(
          harness.contextScriptPath,
          harness.humanGatesScriptPath,
        ),
      });

      await runGeneratedWorkflow(dir, harness);

      const calls = await readWorkflowCalls(harness.callsPath);
      const contextIndex = calls.findIndex(
        (call) => call.type === "task-context" && call.taskId === "TASK-1",
      );
      const implementerIndex = calls.findIndex(
        (call) => call.type === "run" && call.name === "implementer",
      );
      const implementer = calls[implementerIndex];

      expect(contextIndex).toBeGreaterThan(-1);
      expect(implementerIndex).toBeGreaterThan(contextIndex);
      expect(implementer).toMatchObject({
        type: "run",
        promptArgs: {
          TASK_ID: "TASK-1",
          TASK_CONTEXT: JSON.stringify({
            id: "TASK-1",
            body: "authoritative context for TASK-1",
          }),
        },
      });
    },
  );

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s stops before planning when human gate is open",
    async (templateName) => {
      const dir = await makeDir();
      const harness = await writeWorkflowHarness(dir, {
        humanGateOutput: "present",
      });
      await runScaffold(dir, {
        templateName,
        backlogManager: workflowBacklogManager(
          harness.contextScriptPath,
          harness.humanGatesScriptPath,
        ),
      });

      await expect(runGeneratedWorkflow(dir, harness)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("TASK-HITL"),
      });

      const calls = await readWorkflowCalls(harness.callsPath);
      expect(calls).toContainEqual({ type: "human-gates" });
      expect(calls.some((call) => call.type === "run")).toBe(false);
      expect(calls.some((call) => call.type === "task-context")).toBe(false);
      expect(calls.some((call) => call.type === "createSandbox")).toBe(false);
    },
  );

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s skips implementer launch when task context is missing",
    async (templateName) => {
      const dir = await makeDir();
      const harness = await writeWorkflowHarness(dir, {
        contextOutput: "empty",
      });
      await runScaffold(dir, {
        templateName,
        backlogManager: workflowBacklogManager(
          harness.contextScriptPath,
          harness.humanGatesScriptPath,
        ),
      });

      const { stderr } = await runGeneratedWorkflow(dir, harness);

      const calls = await readWorkflowCalls(harness.callsPath);
      expect(calls).toContainEqual({ type: "task-context", taskId: "TASK-1" });
      expect(
        calls.some(
          (call) => call.type === "run" && call.name === "implementer",
        ),
      ).toBe(false);
      expect(stderr).toContain("TASK-1");
      expect(stderr).toContain("Task context command produced no output");
    },
  );

  it("createLabel defaults to true (label retained when not specified)", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("--label Sandcastle");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])("%s includes a human gate stopper", async (templateName) => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName,
      backlogManager: getBacklogManager("beads"),
    });

    const main = await readFile(join(dir, ".sandcastle", "main.mts"), "utf-8");
    expect(main).toContain("stopIfHumanGateOpen");
    expect(main).toContain("bd list --label ready-for-human");
    expect(main).not.toContain("{{HUMAN_GATES_COMMAND}}");
  });

  describe("parallel-planner template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts uses npm install hook and imports sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("npm install");
      expect(mainTs).toContain("sandcastle");
    });

    it("main.mts imports from @ecology91/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ecology91/sandcastle"');
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // All factory calls should use the specified model (default: claude-opus-4-6)
      expect(mainTs).toContain("claude-opus-4-6");
    });

    it("implement-prompt.md contains task routing and context prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
      expect(prompt).toContain("{{TASK_CONTEXT}}");
    });

    it("main.mts loads task context before launching each implementer", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const contextIndex = mainTs.indexOf(
        "const taskContext = await loadTaskContext(issue.id);",
      );
      const runIndex = mainTs.indexOf("sandcastle.run({", contextIndex);

      expect(contextIndex).toBeGreaterThan(-1);
      expect(runIndex).toBeGreaterThan(contextIndex);
      expect(mainTs).toContain("TASK_CONTEXT: taskContext");
      expect(mainTs).toContain("Task context command produced no output");
      expect(mainTs).toContain("Failed to load task context for ${taskId}");
      expect(mainTs).toContain(
        "The host loads deterministic task context before the implementer starts",
      );
      expect(mainTs).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("main.mts requires commits and completion signal before merge input", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const mergeEligibilitySection = mainTs.slice(
        mainTs.indexOf("const completedIssues = settled"),
        mainTs.indexOf("const completedBranches = completedIssues"),
      );

      expect(mergeEligibilitySection).toContain(
        'entry.outcome.status === "fulfilled"',
      );
      expect(mergeEligibilitySection).toContain(
        "entry.outcome.value.completionSignal !== undefined",
      );
      expect(mergeEligibilitySection).toContain(
        "entry.outcome.value.commits.length > 0",
      );
      expect(mainTs).toContain("Skipped incomplete branch");
      expect(mainTs).toContain("completed but produced no commits");
      expect(mainTs).toContain(
        "Merge eligibility is conservative: fulfilled run, completion signal",
      );
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("merge-prompt.md only instructs closing merge-eligible issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("Only close issue IDs listed below");
      expect(prompt).toContain("same merge-eligible task list");
      expect(prompt).not.toContain("Here are all the issues");
    });

    it("main.mts always uses the merge agent regardless of branch count", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("completedBranches.length === 1");
    });

    it("common files are still generated with parallel-planner template", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → ANTHROPIC_API_KEY, default backlog → GH_TOKEN
      expect(envExample).toContain("ANTHROPIC_API_KEY=");
      expect(envExample).toContain("GH_TOKEN=");
    });
  });

  describe("parallel-planner-with-review template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, review-prompt.md, merge-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts imports from @ecology91/sandcastle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@ecology91/sandcastle"');
    });

    it("main.mts uses createSandbox for shared sandbox per branch", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
    });

    it("main.mts runs implementer then reviewer sequentially within each sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
      expect(mainTs).toContain("implement.commits.length > 0");
    });

    it("main.mts captures reviewer result and merges commits from both runs", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Reviewer result must be captured, not discarded
      expect(mainTs).toContain("const review = await sandbox.run");
      // Commits from both implementer and reviewer must be merged
      expect(mainTs).toContain("implement.commits");
      expect(mainTs).toContain("review.commits");
    });

    it("main.mts uses Promise.allSettled for parallel execution", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("Promise.allSettled");
    });

    it("main.mts has correct maxIterations: planner=1, implementer=100, reviewer=1, merger=1", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      // Check planner maxIterations: 1 (near "planner" name)
      const plannerSection = mainTs.slice(
        mainTs.indexOf('name: "planner"') - 200,
        mainTs.indexOf('name: "planner"') + 200,
      );
      expect(plannerSection).toContain("maxIterations: 1");

      // Check implementer maxIterations: 100
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"') - 200,
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 100");

      // Check reviewer maxIterations: 1
      const reviewerSection = mainTs.slice(
        mainTs.indexOf('name: "reviewer"') - 200,
        mainTs.indexOf('name: "reviewer"') + 200,
      );
      expect(reviewerSection).toContain("maxIterations: 1");

      // Check merger maxIterations: 1
      const mergerSection = mainTs.slice(
        mainTs.indexOf('name: "merger"') - 200,
        mainTs.indexOf('name: "merger"') + 200,
      );
      expect(mergerSection).toContain("maxIterations: 1");
    });

    it("implement-prompt.md contains task routing and context prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
      expect(prompt).toContain("{{TASK_CONTEXT}}");
    });

    it("main.mts loads task context before launching each implementer", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const contextIndex = mainTs.indexOf(
        "const taskContext = await loadTaskContext(issue.id);",
      );
      const sandboxIndex = mainTs.indexOf(
        "sandcastle.createSandbox",
        contextIndex,
      );
      const runIndex = mainTs.indexOf("sandbox.run({", contextIndex);

      expect(contextIndex).toBeGreaterThan(-1);
      expect(sandboxIndex).toBeGreaterThan(contextIndex);
      expect(runIndex).toBeGreaterThan(contextIndex);
      expect(mainTs).toContain("TASK_CONTEXT: taskContext");
      expect(mainTs).toContain("Task context command produced no output");
      expect(mainTs).toContain("Failed to load task context for ${taskId}");
      expect(mainTs).toContain(
        "load deterministic task context before creating a sandbox",
      );
      expect(mainTs).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("main.mts gates review and merge by implementer and reviewer completion evidence", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      const reviewerLaunchSection = mainTs.slice(
        mainTs.indexOf("// Only review"),
        mainTs.indexOf("} finally"),
      );
      const mergeEligibilitySection = mainTs.slice(
        mainTs.indexOf("const completedIssues = settled"),
        mainTs.indexOf("const completedBranches = completedIssues"),
      );

      expect(reviewerLaunchSection).toContain(
        "implement.commits.length > 0 &&",
      );
      expect(reviewerLaunchSection).toContain(
        "implement.completionSignal !== undefined",
      );
      expect(reviewerLaunchSection).toContain("review: undefined");
      expect(reviewerLaunchSection).toContain(
        "implementer commits present but completion signal missing",
      );
      expect(reviewerLaunchSection).toContain(
        "implementer completed but produced no commits",
      );

      expect(mergeEligibilitySection).toContain(
        'entry.outcome.status === "fulfilled"',
      );
      expect(mergeEligibilitySection).toContain(
        "entry.outcome.value.implement.completionSignal !== undefined",
      );
      expect(mergeEligibilitySection).toContain(
        "entry.outcome.value.implement.commits.length > 0",
      );
      expect(mergeEligibilitySection).toContain(
        "entry.outcome.value.review !== undefined",
      );
      expect(mergeEligibilitySection).toContain(
        "entry.outcome.value.review.completionSignal !== undefined",
      );
      expect(mergeEligibilitySection).not.toContain(
        "entry.outcome.value.review.commits.length > 0",
      );
      expect(mainTs).toContain("Skipped incomplete review");
      expect(mainTs).toContain(
        "Merge eligibility is conservative: implementer commits plus",
      );
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("merge-prompt.md contains {{BRANCHES}} and {{ISSUES}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCHES}}");
      expect(prompt).toContain("{{ISSUES}}");
    });

    it("merge-prompt.md only instructs closing merge-eligible issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("Only close issue IDs listed below");
      expect(prompt).toContain("same merge-eligible task list");
      expect(prompt).not.toContain("Here are all the issues");
    });

    it("parallel-planner-with-review appears in listTemplates()", () => {
      const templates = listTemplates();
      expect(
        templates.some((t) => t.name === "parallel-planner-with-review"),
      ).toBe(true);
    });

    it("common files are still generated", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → ANTHROPIC_API_KEY, default backlog → GH_TOKEN
      expect(envExample).toContain("ANTHROPIC_API_KEY=");
      expect(envExample).toContain("GH_TOKEN=");
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("claude-opus-4-6");
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const standards = await readFile(
        join(dir, ".sandcastle", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.sandcastle/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.sandcastle/CODING_STANDARDS.md");
    });

    it("review-prompt.md uses {{SOURCE_BRANCH}} instead of hardcoded main", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{SOURCE_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{SOURCE_BRANCH}}..{{BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });
  });

  // --- Backlog manager ---

  describe("Backlog manager registry", () => {
    it("listBacklogManagers returns github-issues and beads", () => {
      const managers = listBacklogManagers();
      expect(managers.some((m) => m.name === "github-issues")).toBe(true);
      expect(managers.some((m) => m.name === "beads")).toBe(true);
    });

    it("getBacklogManager returns github-issues entry with expected templateArgs", () => {
      const manager = getBacklogManager("github-issues");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("GitHub Issues");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "gh issue list",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("labels");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("comments");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain(
        "gh issue view",
      );
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain(
        "gh issue close",
      );
      expect(manager!.templateArgs.HUMAN_GATES_COMMAND).toContain(
        "ready-for-human",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain(
        "GitHub CLI",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain("gh");
    });

    it("getBacklogManager returns beads entry with expected templateArgs", () => {
      const manager = getBacklogManager("beads");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("Beads");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toBe("bd ready --json");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toBe(BEADS_VIEW_COMMAND);
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("bd show");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("bd comments");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain("--json");
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toBe(
        BEADS_CLOSE_COMMAND,
      );
      expect(manager!.templateArgs.HUMAN_GATES_COMMAND).toBe(
        "bd list --label ready-for-human --status open,deferred --json --limit 0",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain("beads");
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain("libicu72");
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain(
        "corepack enable",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).not.toContain("gh");
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).not.toContain(
        "x86_64-linux-gnu",
      );
      expect(manager!.templateArgs.BACKLOG_MANAGER_TOOLS).toContain(
        "dpkg-architecture -qDEB_HOST_MULTIARCH",
      );
    });

    it("getBacklogManager returns undefined for unknown manager", () => {
      expect(getBacklogManager("nonexistent")).toBeUndefined();
    });
  });

  describe("Backlog manager scaffold", () => {
    it("simple-loop with github-issues produces prompt with gh issue commands (richer version)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("simple-loop with beads produces prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain(BEADS_CLOSE_COMMAND);
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toMatch(/GitHub issues?/);
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("simple-loop with beads skips --label Sandcastle (no label to strip)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
    });

    it("simple-loop with github-issues retains --label Sandcastle when createLabel is true", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("github-issues"),
        createLabel: true,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("--label Sandcastle");
    });

    it("simple-loop with github-issues strips --label Sandcastle when createLabel is false", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        backlogManager: getBacklogManager("github-issues"),
        createLabel: false,
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("--label Sandcastle");
      expect(prompt).toContain("gh issue list");
    });

    it("scaffold without backlogManager defaults to github-issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      // Should default to github-issues and replace placeholders
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    // --- sequential-reviewer ---

    it("sequential-reviewer with github-issues produces implement-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("sequential-reviewer with beads produces implement-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).toContain(BEADS_CLOSE_COMMAND);
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toMatch(/GitHub issues?/);
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    // --- blank ---

    it("blank with github-issues produces prompt with gh issue list example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("blank with beads produces prompt with bd ready example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("bd ready --json");
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    // --- parallel-planner ---

    it("parallel-planner with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).toContain("output an empty `issues` array");
      expect(planPrompt).toContain("ready-for-human");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner plan-prompt example uses a non-numeric string id", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain('"id": "bd-a1b2"');
      expect(planPrompt).toContain(
        '"branch": "sandcastle/issue-bd-a1b2-fix-auth-bug"',
      );
      expect(planPrompt).not.toContain('"id": "42"');
    });

    it("parallel-planner main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: string");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner with github-issues loads task context in main.mts", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("github-issues"),
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("gh issue view <ID>");
      expect(main).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner with beads loads task context with JSON commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("beads"),
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain(BEADS_VIEW_COMMAND);
      expect(main).not.toContain("gh issue");
      expect(main).not.toContain("{{VIEW_TASK_COMMAND}}");
      expect(main).not.toContain(".beads");
    });

    it("parallel-planner with github-issues produces merge-prompt with gh issue close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(BEADS_CLOSE_COMMAND);
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- parallel-planner-with-review ---

    it("parallel-planner-with-review with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces plan-prompt with bd commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("beads"),
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("bd ready --json");
      expect(planPrompt).toContain("output an empty `issues` array");
      expect(planPrompt).toContain("ready-for-human");
      expect(planPrompt).not.toContain("gh issue");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review plan-prompt example uses a non-numeric string id", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const planPrompt = await readFile(
        join(dir, ".sandcastle", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain('"id": "bd-a1b2"');
      expect(planPrompt).toContain(
        '"branch": "sandcastle/issue-bd-a1b2-fix-auth-bug"',
      );
      expect(planPrompt).not.toContain('"id": "42"');
    });

    it("parallel-planner-with-review main.mts uses id:string and TASK_ID", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("id: string");
      expect(main).toContain("TASK_ID: issue.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner-with-review implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner-with-review with github-issues loads task context in main.mts", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("github-issues"),
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain("gh issue view <ID>");
      expect(main).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with beads loads task context with JSON commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("beads"),
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain(BEADS_VIEW_COMMAND);
      expect(main).not.toContain("gh issue");
      expect(main).not.toContain("{{VIEW_TASK_COMMAND}}");
      expect(main).not.toContain(".beads");
    });

    it("parallel-planner-with-review with github-issues produces merge-prompt with gh issue close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue close");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review with beads produces merge-prompt with bd close", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        backlogManager: getBacklogManager("beads"),
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "merge-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(BEADS_CLOSE_COMMAND);
      expect(prompt).not.toContain("gh issue");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".sandcastle", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- Dockerfile backlog manager tools ---

    it("scaffold with github-issues produces Dockerfile with GitHub CLI install", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        backlogManager: getBacklogManager("github-issues"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("GitHub CLI");
      expect(dockerfile).toContain("gh");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    });

    it("scaffold with beads produces Dockerfile with beads install (no GitHub CLI)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        backlogManager: getBacklogManager("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("libicu72");
      expect(dockerfile).toContain("corepack enable");
      expect(dockerfile).not.toContain("GitHub CLI");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
      expect(dockerfile).not.toContain("x86_64-linux-gnu");
      expect(dockerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + podman produces Containerfile with beads install", async () => {
      const dir = await makeDir();
      const podmanProvider = getSandboxProvider("podman")!;
      await runScaffold(dir, {
        backlogManager: getBacklogManager("beads"),
        sandboxProvider: podmanProvider,
      });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("beads");
      expect(containerfile).toContain("libicu72");
      expect(containerfile).not.toContain("GitHub CLI");
      expect(containerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
      expect(containerfile).not.toContain("x86_64-linux-gnu");
      expect(containerfile).toContain("dpkg-architecture -qDEB_HOST_MULTIARCH");
    });

    it("scaffold with beads + pi agent produces Dockerfile with beads install and pi agent", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        agent: piAgent,
        model: "claude-sonnet-4-6",
        backlogManager: getBacklogManager("beads"),
      });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("@mariozechner/pi-coding-agent");
      expect(dockerfile).not.toContain("GitHub CLI");
    });

    it("scaffold with beads + opencode agent combines opencode and beads setup", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        agent: opencodeAgent,
        model: opencodeAgent.defaultModel,
        backlogManager: getBacklogManager("beads"),
      });

      const configDir = join(dir, ".sandcastle");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("opencode-ai");
      expect(dockerfile).toContain("beads");
      expect(dockerfile).toContain("libicu72");
      expect(dockerfile).not.toContain("GitHub CLI");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain("OPENCODE_API_KEY=");
      expect(envExample).not.toContain("GH_TOKEN=");

      const main = await readFile(join(configDir, "main.mts"), "utf-8");
      expect(main).toContain("opencode(");
      expect(main).not.toContain("claudeCode");
    });
  });

  // --- ESM extension detection ---

  describe("main file extension detection", () => {
    it("scaffolds main.mts when no package.json exists", async () => {
      const dir = await makeDir();
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).resolves.toBeUndefined();
    });

    it("scaffolds main.mts when package.json has no type field", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(mainContent).toContain("@ecology91/sandcastle");
    });

    it("scaffolds main.mts when package.json has type: commonjs", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "commonjs" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });

    it("scaffolds main.ts when package.json has type: module", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.ts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "main.ts")),
      ).resolves.toBeUndefined();
      // main.mts should NOT exist
      await expect(
        access(join(dir, ".sandcastle", "main.mts")),
      ).rejects.toThrow();
    });

    it("main.ts scaffolded with type: module has correct imports and factory calls", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain("@ecology91/sandcastle");
      expect(mainContent).toContain('claudeCode("claude-opus-4-6")');
    });

    it("main.ts scaffolded with type: module rewrites agent factory correctly", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir, { agent: piAgent, model: "claude-sonnet-4-6" });

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain('pi("claude-sonnet-4-6")');
      expect(mainContent).not.toContain("claudeCode");
    });

    it("comments in scaffolded main.ts reference main.ts, not main.mts", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".sandcastle", "main.ts"),
        "utf-8",
      );
      expect(mainContent).not.toContain("main.mts");
      expect(mainContent).toContain("main.ts");
    });

    it("scaffolds main.mts when package.json is invalid JSON", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "package.json"), "not valid json{{{");
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });
  });

  // ---------------------------------------------------------------------------
  // Sandbox provider selection
  // ---------------------------------------------------------------------------

  describe("sandbox provider", () => {
    const dockerProvider = getSandboxProvider("docker")!;
    const podmanProvider = getSandboxProvider("podman")!;

    it("selecting docker writes Dockerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const dockerfile = await readFile(
        join(dir, ".sandcastle", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    });

    it("selecting docker leaves simple-loop main.mts using docker", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        sandboxProvider: dockerProvider,
      });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain(
        'import { docker } from "@ecology91/sandcastle/sandboxes/docker";',
      );
      expect(main).toContain("sandbox: docker()");
      expect(main).toContain("Docker is the default runtime");
      expect(main).not.toContain("sandboxes/podman");
      expect(main).not.toContain("sandbox: podman()");
    });

    it("selecting podman writes Containerfile to .sandcastle/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const containerfile = await readFile(
        join(dir, ".sandcastle", "Containerfile"),
        "utf-8",
      );
      expect(containerfile).toContain("FROM node:22-bookworm");
      expect(containerfile).not.toContain("{{BACKLOG_MANAGER_TOOLS}}");
    });

    it("selecting podman rewrites the default scaffolded main.mts runtime", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const main = await readFile(
        join(dir, ".sandcastle", "main.mts"),
        "utf-8",
      );
      expect(main).toContain(
        'import { podman } from "@ecology91/sandcastle/sandboxes/podman";',
      );
      expect(main).toContain("sandbox: podman()");
      expect(main).not.toContain("sandboxes/docker");
      expect(main).not.toContain("sandbox: docker()");
    });

    for (const template of listTemplates()) {
      it(`selecting podman rewrites ${template.name} main.mts runtime`, async () => {
        const dir = await makeDir();
        await runScaffold(dir, {
          templateName: template.name,
          sandboxProvider: podmanProvider,
        });

        const main = await readFile(
          join(dir, ".sandcastle", "main.mts"),
          "utf-8",
        );
        expect(main).toContain(
          'import { podman } from "@ecology91/sandcastle/sandboxes/podman";',
        );
        expect(main).toContain("podman()");
        expect(main).not.toContain("sandboxes/docker");
        expect(main).not.toContain("docker()");
        expect(main).not.toContain("Docker is the default runtime");
        if (template.name === "simple-loop") {
          expect(main).toContain("Podman is the selected runtime");
        }
      });
    }

    it("selecting podman does not write Dockerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: podmanProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Dockerfile")),
      ).rejects.toThrow();
    });

    it("selecting docker does not write Containerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".sandcastle", "Containerfile")),
      ).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Sandbox provider registry
// ---------------------------------------------------------------------------

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns docker and podman", () => {
    const providers = listSandboxProviders();
    expect(providers.some((p) => p.name === "docker")).toBe(true);
    expect(providers.some((p) => p.name === "podman")).toBe(true);
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("docker");
    expect(provider!.runtimeImportPath).toBe(
      "@ecology91/sandcastle/sandboxes/docker",
    );
    expect(provider!.runtimeFactoryName).toBe("docker");
    expect(provider!.runtimeLabel).toBe("Docker");
  });

  it("getSandboxProvider returns podman entry", () => {
    const provider = getSandboxProvider("podman");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Containerfile");
    expect(provider!.cliNamespace).toBe("podman");
    expect(provider!.runtimeImportPath).toBe(
      "@ecology91/sandcastle/sandboxes/podman",
    );
    expect(provider!.runtimeFactoryName).toBe("podman");
    expect(provider!.runtimeLabel).toBe("Podman");
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});
