import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildCompletionMessage,
  buildContextWindowLines,
  buildLogFilename,
  buildRunSummaryRows,
  DEFAULT_MAX_ITERATIONS,
  formatContextWindowSize,
  printFileDisplayStartup,
  run,
  sanitizeBranchForFilename,
  type RunOptions,
  type RunResult,
} from "./run.js";
import {
  claudeCode,
  codex,
  opencode,
  pi,
  type AgentProvider,
} from "./AgentProvider.js";
import { defaultImageName } from "./sandboxes/docker.js";
import * as sandcastle from "./SandboxProvider.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";

const testSandbox = createBindMountSandboxProvider({
  name: "test",
  create: async () => ({
    worktreePath: "/home/agent/workspace",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    copyFileIn: async () => {},
    copyFileOut: async () => {},
    close: async () => {},
  }),
});

const terminalOutputAgent: AgentProvider = {
  name: "test-agent",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: "mock-agent" }),
  parseStreamLine: (line) => {
    const parsed = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
      result?: string;
      name?: string;
      args?: string;
    };
    if (parsed.type === "assistant") {
      return (parsed.message?.content ?? [])
        .filter(
          (content): content is { type: string; text: string } =>
            content.type === "text" && typeof content.text === "string",
        )
        .map((content) => ({ type: "text" as const, text: content.text }));
    }
    if (parsed.type === "result" && typeof parsed.result === "string") {
      return [{ type: "result" as const, result: parsed.result }];
    }
    if (
      parsed.type === "tool_call" &&
      typeof parsed.name === "string" &&
      typeof parsed.args === "string"
    ) {
      return [
        { type: "tool_call" as const, name: parsed.name, args: parsed.args },
      ];
    }
    return [];
  },
};

const createTerminalOutputHarness = (
  envFileContent?: string,
  options?: {
    readonly agent?: AgentProvider;
    readonly streamLines?: readonly string[];
    readonly commandMatches?: (command: string) => boolean;
  },
): {
  readonly dir: string;
  readonly agent: AgentProvider;
  readonly createCalls: Array<Record<string, string>>;
  readonly sandbox: ReturnType<typeof createBindMountSandboxProvider>;
} => {
  const dir = mkdtempSync(join(tmpdir(), "sandcastle-terminal-output-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: "ignore",
  });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "initial"', { cwd: dir, stdio: "ignore" });

  if (envFileContent !== undefined) {
    mkdirSync(join(dir, ".sandcastle"), { recursive: true });
    writeFileSync(join(dir, ".sandcastle", ".env"), envFileContent);
  }

  const createCalls: Array<Record<string, string>> = [];
  const agent = options?.agent ?? terminalOutputAgent;
  const streamLines = options?.streamLines ?? [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "mock agent text <promise>COMPLETE</promise>",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "result",
      result: "mock agent text <promise>COMPLETE</promise>",
    }),
  ];
  const commandMatches =
    options?.commandMatches ?? ((command: string) => command === "mock-agent");
  const sandbox = createBindMountSandboxProvider({
    name: "test-sandbox",
    create: async (createOptions) => {
      createCalls.push(createOptions.env);
      return {
        worktreePath: createOptions.worktreePath,
        exec: async (command, options) => {
          if (commandMatches(command)) {
            for (const line of streamLines) {
              options?.onLine?.(line);
            }
            return { stdout: streamLines.join("\n"), stderr: "", exitCode: 0 };
          }
          if (command.includes("git rev-parse --abbrev-ref HEAD")) {
            return { stdout: "main\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      };
    },
  });

  return { dir, agent, createCalls, sandbox };
};

describe("printFileDisplayStartup", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.FORCE_COLOR = "1";
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.FORCE_COLOR;
  });

  it("does not use clack (no @clack/prompts calls)", async () => {
    const clack = await import("@clack/prompts");
    const clackSpy = vi
      .spyOn(clack.log, "success")
      .mockImplementation(() => {});
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    expect(clackSpy).not.toHaveBeenCalled();
    clackSpy.mockRestore();
  });

  it("uses console.log for output", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("shows '[Agent] Started' when no name is provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("[Agent]");
    expect(allOutput).toContain("Started");
  });

  it("shows custom agent name when provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
      agentName: "my-run",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("[my-run]");
  });

  it("shows branch name when provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
      branch: "sandcastle/issue-124-file-logging",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("sandcastle/issue-124-file-logging");
  });

  it("shows tail command with relative log path", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("tail -f");
  });

  it("uses bold styling for the agent name bracket", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    // Bold ANSI escape code
    expect(allOutput).toContain("\u001b[1m");
  });

  it("prints a relative log path when hostRepoDir equals process.cwd()", () => {
    const logPath = join(process.cwd(), ".sandcastle", "logs", "main.log");
    printFileDisplayStartup({
      logPath,
      hostRepoDir: process.cwd(),
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("tail -f .sandcastle/logs/main.log");
    expect(allOutput).not.toContain(process.cwd());
  });

  it("prints an absolute log path when hostRepoDir differs from process.cwd()", () => {
    const hostRepoDir = "/some/other/repo";
    const logPath = join(hostRepoDir, ".sandcastle", "logs", "main.log");
    printFileDisplayStartup({
      logPath,
      hostRepoDir,
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain(
      "tail -f /some/other/repo/.sandcastle/logs/main.log",
    );
  });
});

describe("buildCompletionMessage", () => {
  it("returns success message when completion signal was detected", () => {
    const result = buildCompletionMessage("<promise>COMPLETE</promise>", 3);
    expect(result.message).toBe(
      "Run complete: agent finished after 3 iteration(s).",
    );
    expect(result.severity).toBe("success");
  });

  it("returns warn message when max iterations reached without signal", () => {
    const result = buildCompletionMessage(undefined, 5);
    expect(result.message).toBe(
      "Run complete: reached 5 iteration(s) without completion signal.",
    );
    expect(result.severity).toBe("warn");
  });

  it("reflects the correct iteration count for 1 iteration", () => {
    const result = buildCompletionMessage("<promise>COMPLETE</promise>", 1);
    expect(result.message).toContain("1 iteration(s)");
  });
});

describe("RunResult", () => {
  it("includes logFilePath when logging to a file", () => {
    const result: RunResult = {
      iterations: [{ sessionId: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
      logFilePath: "/path/to/sandcastle.log",
    };
    expect(result.logFilePath).toBe("/path/to/sandcastle.log");
  });

  it("allows logFilePath to be absent when logging to stdout", () => {
    const result: RunResult = {
      iterations: [{ sessionId: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.logFilePath).toBeUndefined();
  });

  it("carries sessionId in iterations for Claude Code runs", () => {
    const result: RunResult = {
      iterations: [{ sessionId: "abc-123" }, { sessionId: "def-456" }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations.length).toBe(2);
    expect(result.iterations[0]!.sessionId).toBe("abc-123");
    expect(result.iterations[1]!.sessionId).toBe("def-456");
  });

  it("has undefined sessionId for non-Claude agent iterations", () => {
    const result: RunResult = {
      iterations: [{ sessionId: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations[0]!.sessionId).toBeUndefined();
  });

  it("carries sessionFilePath when session capture is enabled", () => {
    const result: RunResult = {
      iterations: [
        {
          sessionId: "abc-123",
          sessionFilePath:
            "/home/user/.claude/projects/-home-user-repo/abc-123.jsonl",
        },
      ],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations[0]!.sessionFilePath).toContain("abc-123.jsonl");
  });

  it("has undefined sessionFilePath when capture is disabled", () => {
    const result: RunResult = {
      iterations: [{ sessionId: "abc-123", sessionFilePath: undefined }],
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.iterations[0]!.sessionFilePath).toBeUndefined();
  });
});

describe("DEFAULT_MAX_ITERATIONS", () => {
  it("is 1", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(1);
  });
});

describe("RunOptions", () => {
  it("requires agent field typed as AgentProvider", () => {
    // @ts-expect-error agent is required
    const _opts: RunOptions = { prompt: "test" };
  });

  it("requires sandbox field typed as SandboxProvider", () => {
    // @ts-expect-error sandbox is required
    const _opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      prompt: "test",
    };
  });

  it("allows idleTimeoutSeconds to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
      idleTimeoutSeconds: 120,
    };
    expect(opts.idleTimeoutSeconds).toBe(120);
  });

  it("allows idleTimeoutSeconds to be omitted (uses default)", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.idleTimeoutSeconds).toBeUndefined();
  });

  it("allows name to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
      name: "my-run",
    };
    expect(opts.name).toBe("my-run");
  });

  it("allows name to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.name).toBeUndefined();
  });

  it("does not accept a worktree field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error worktree is no longer a valid field on RunOptions
    expect(opts.worktree).toBeUndefined();
  });

  it("allows cwd to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
      cwd: "/some/repo",
    };
    expect(opts.cwd).toBe("/some/repo");
  });

  it("allows cwd to be omitted (defaults to process.cwd())", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.cwd).toBeUndefined();
  });

  it("does not accept a top-level branch field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error branch is no longer a valid field on RunOptions
    expect(opts.branch).toBeUndefined();
  });

  it("does not accept a top-level imageName field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error imageName is no longer a valid field on RunOptions
    expect(opts.imageName).toBeUndefined();
  });
});

describe("signal (AbortSignal)", () => {
  it("allows signal to be specified on RunOptions", () => {
    const ac = new AbortController();
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
      signal: ac.signal,
    };
    expect(opts.signal).toBe(ac.signal);
  });

  it("allows signal to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.signal).toBeUndefined();
  });

  it("rejects immediately with pre-aborted signal without doing setup", async () => {
    const ac = new AbortController();
    ac.abort("cancelled before start");
    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        signal: ac.signal,
      }),
    ).rejects.toThrow("cancelled before start");
  });

  it("surfaces signal.reason verbatim (no wrapping)", async () => {
    const reason = new DOMException("user cancelled", "AbortError");
    const ac = new AbortController();
    ac.abort(reason);
    try {
      await run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        signal: ac.signal,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(reason);
    }
  });
});

describe("resumeSession validation", () => {
  it("throws when resumeSession is set with maxIterations > 1", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        resumeSession: "abc-123",
        maxIterations: 2,
      }),
    ).rejects.toThrow(
      "resumeSession cannot be combined with maxIterations > 1",
    );
  });

  it("throws when resumeSession file does not exist on host", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        resumeSession: "nonexistent-session-id",
      }),
    ).rejects.toThrow('resumeSession "nonexistent-session-id" not found');
  });

  it("allows resumeSession with maxIterations = 1 (default)", async () => {
    // This should fail for a different reason (missing session file),
    // not the maxIterations validation
    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        resumeSession: "abc-123",
      }),
    ).rejects.toThrow('resumeSession "abc-123" not found');
  });
});

describe("copyToWorktree with head branch strategy", () => {
  it("throws a runtime error when copyToWorktree is provided with head strategy", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        copyToWorktree: [".env"],
      }),
    ).rejects.toThrow(
      "copyToWorktree is not supported with head branch strategy",
    );
  });
});

describe("branchStrategy on RunOptions", () => {
  it("throws when head strategy is used with an isolated provider", async () => {
    const isolatedSandbox = sandcastle.createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => ({
        worktreePath: "/workspace",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: isolatedSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
      }),
    ).rejects.toThrow(
      "head branch strategy is not supported with isolated providers",
    );
  });
});

describe("buildRunSummaryRows", () => {
  it("uses the custom name as Agent when name is provided", () => {
    const rows = buildRunSummaryRows({
      name: "Implementer #202",
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 3,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("Implementer #202");
  });

  it("falls back to agentName when no name is provided", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 1,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("claude-code");
  });

  it("includes sandbox name, max iterations, and branch", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 5,
      branch: "sandcastle/issue-160",
    });
    expect(rows["Sandbox"]).toBe("docker");
    expect(rows["Max iterations"]).toBe("5");
    expect(rows["Branch"]).toBe("sandcastle/issue-160");
  });

  it("does not include a Model row", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 1,
      branch: "main",
    });
    expect(rows["Model"]).toBeUndefined();
  });
});

describe("sanitizeBranchForFilename", () => {
  it("passes through a simple branch name unchanged", () => {
    expect(sanitizeBranchForFilename("main")).toBe("main");
  });

  it("replaces forward slashes with dashes", () => {
    expect(sanitizeBranchForFilename("sandcastle/issue-87-log-file")).toBe(
      "sandcastle-issue-87-log-file",
    );
  });

  it("replaces backslashes with dashes", () => {
    expect(sanitizeBranchForFilename("feature\\branch")).toBe("feature-branch");
  });

  it("replaces all problematic filesystem characters", () => {
    expect(sanitizeBranchForFilename('feat:name*?"><|')).toBe(
      "feat-name------",
    );
  });

  it("handles nested slashes like a typical sandcastle branch", () => {
    expect(
      sanitizeBranchForFilename("sandcastle/issue-87-log-file-branch-name"),
    ).toBe("sandcastle-issue-87-log-file-branch-name");
  });
});

describe("defaultImageName", () => {
  it("returns sandcastle:<dir-name> for a typical repo path", () => {
    expect(defaultImageName("/home/user/my-project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("lowercases the directory name", () => {
    expect(defaultImageName("/home/user/MyProject")).toBe(
      "sandcastle:myproject",
    );
  });

  it("replaces characters invalid in Docker image tags with dashes", () => {
    expect(defaultImageName("/home/user/my project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("handles paths with trailing slash gracefully", () => {
    expect(defaultImageName("/home/user/my-repo/")).toBe("sandcastle:my-repo");
  });
});

describe("buildLogFilename", () => {
  it("returns sanitized branch + .log when no target branch", () => {
    expect(buildLogFilename("main")).toBe("main.log");
  });

  it("prefixes with target branch when temp branch is used", () => {
    expect(buildLogFilename("sandcastle/20260325-142719", "main")).toBe(
      "main-sandcastle-20260325-142719.log",
    );
  });

  it("sanitizes target branch with slashes", () => {
    expect(
      buildLogFilename("sandcastle/20260325-142719", "feature/my-work"),
    ).toBe("feature-my-work-sandcastle-20260325-142719.log");
  });

  it("includes agent name when branch contains agent segment", () => {
    expect(
      buildLogFilename("sandcastle/claude-code/20260325-142719", "main"),
    ).toBe("main-sandcastle-claude-code-20260325-142719.log");
  });

  it("appends run name when name is provided", () => {
    expect(buildLogFilename("main", undefined, "implementer")).toBe(
      "main-implementer.log",
    );
  });

  it("appends run name after target branch prefix", () => {
    expect(
      buildLogFilename("sandcastle/20260325-142719", "main", "reviewer"),
    ).toBe("main-sandcastle-20260325-142719-reviewer.log");
  });

  it("sanitizes run name for filename use", () => {
    expect(buildLogFilename("main", undefined, "my review agent")).toBe(
      "main-my-review-agent.log",
    );
  });
});

describe("promptFile resolution with cwd", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("resolves relative promptFile from process.cwd(), not from cwd", async () => {
    // ADR 0002 regression: promptFile must resolve against process.cwd()
    // regardless of what cwd is set to. This locks in the decision so it
    // is not accidentally reversed.
    const cwdDir = mkdtempSync(join(tmpdir(), "sandcastle-cwd-"));

    // Use a relative promptFile path that does not exist under either
    // process.cwd() or the custom cwd. The error message must reference
    // a resolution against process.cwd(), not cwdDir.
    const relativePromptFile = "nonexistent-prompt-file.md";

    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        promptFile: relativePromptFile,
        branchStrategy: { type: "head" },
        cwd: cwdDir,
      }),
    ).rejects.toThrow(relativePromptFile);
  });
});

describe("inline prompt passthrough", () => {
  it("errors when promptArgs is passed alongside an inline prompt", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "do the work",
        branchStrategy: { type: "head" },
        promptArgs: { ISSUE_NUMBER: "42" },
      }),
    ).rejects.toThrow("promptArgs is only supported with promptFile");
  });

  it("does not error on inline prompts that contain literal {{KEY}} text (issue #453)", async () => {
    // Before the fix, this would fail with "Prompt argument \"{{BRANCH}}\" has no
    // matching value". With inline passthrough, {{KEY}} is delivered literally
    // and substitution is skipped entirely, so no scan happens.
    //
    // The run still fails (fake sandbox can't actually run the agent) but the
    // failure must not be a prompt-substitution error.
    const promise = run({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "Issue body mentions {{BRANCH}} in its content.",
      branchStrategy: { type: "head" },
    });

    await promise.catch((err: Error) => {
      expect(err.message).not.toContain("matching value in promptArgs");
      expect(err.message).not.toContain("{{BRANCH}}");
    });
  });

  it("accepts inline prompt with empty promptArgs ({})", async () => {
    // Spreading `...opts` where `opts.promptArgs` defaults to {} is a common
    // pattern. An empty args object is semantically the same as "not provided"
    // and must not trigger the inline-prompt guard.
    const promise = run({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      promptArgs: {},
    });

    await promise.catch((err: Error) => {
      expect(err.message).not.toContain(
        "promptArgs is only supported with promptFile",
      );
    });
  });
});

describe("run() error logging to file", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("writes SandboxError to log file when using file logging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-run-error-"));
    const logPath = join(dir, "test.log");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "test prompt");

    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        promptArgs: { SOURCE_BRANCH: "override" },
        logging: { type: "file", path: logPath },
      }),
    ).rejects.toThrow();

    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("SOURCE_BRANCH");
    expect(log).toContain("built-in prompt argument");
  });

  it("still propagates the error as a rejected promise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-run-error-"));
    const logPath = join(dir, "test.log");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "test prompt");

    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        promptFile,
        branchStrategy: { type: "head" },
        promptArgs: { SOURCE_BRANCH: "override" },
        logging: { type: "file", path: logPath },
      }),
    ).rejects.toThrow("SOURCE_BRANCH");
  });
});

describe("SANDCASTLE_TERMINAL_OUTPUT", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: { mockRestore: () => void };
  let originalTerminalOutput: string | undefined;

  beforeEach(() => {
    originalTerminalOutput = process.env.SANDCASTLE_TERMINAL_OUTPUT;
    delete process.env.SANDCASTLE_TERMINAL_OUTPUT;
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    stdoutWriteSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    consoleSpy.mockRestore();
    if (originalTerminalOutput === undefined) {
      delete process.env.SANDCASTLE_TERMINAL_OUTPUT;
    } else {
      process.env.SANDCASTLE_TERMINAL_OUTPUT = originalTerminalOutput;
    }
  });

  const runTerminalOutputHarness = async (
    envFileContent: string | undefined,
    name: string,
  ) => {
    const harness = createTerminalOutputHarness(envFileContent);
    const result = await run({
      agent: harness.agent,
      sandbox: harness.sandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      cwd: harness.dir,
      name,
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");
    return { ...harness, result, terminalOutput };
  };

  it("defaults to off and ignores undeclared process env fallback", async () => {
    process.env.SANDCASTLE_TERMINAL_OUTPUT = "verbose";

    const { result, terminalOutput } = await runTerminalOutputHarness(
      undefined,
      "default-off-run",
    );

    expect(result.logFilePath).toBeDefined();
    expect(terminalOutput).toContain("tail -f");
    expect(terminalOutput).toContain("[default-off-run] Started");
    expect(terminalOutput).not.toContain("[default-off-run] Sandcastle Run");
    expect(terminalOutput).not.toContain("[default-off-run] Agent started");
  });

  it("keeps file-only logging when project env explicitly sets off", async () => {
    process.env.SANDCASTLE_TERMINAL_OUTPUT = "verbose";

    const { terminalOutput } = await runTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=off\n",
      "explicit-off-run",
    );

    expect(terminalOutput).toContain("tail -f");
    expect(terminalOutput).not.toContain("[explicit-off-run] Sandcastle Run");
    expect(terminalOutput).not.toContain("[explicit-off-run] Agent started");
  });

  it("adds prefixed lifecycle terminal output while preserving the run log", async () => {
    process.env.SANDCASTLE_TERMINAL_OUTPUT = "off";

    const { createCalls, result, terminalOutput } =
      await runTerminalOutputHarness(
        "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
        "visible-run",
      );

    expect(result.logFilePath).toBeDefined();
    const log = readFileSync(result.logFilePath!, "utf-8");
    expect(log).toContain("Sandcastle Run");
    expect(log).toContain("Agent started");
    expect(terminalOutput).toContain("tail -f");
    expect(terminalOutput).toContain("[visible-run] Sandcastle Run");
    expect(terminalOutput).toContain("[visible-run] Setting up sandbox");
    expect(terminalOutput).toContain("[visible-run] Agent started");
    expect(terminalOutput).toContain("[visible-run] Collecting commits");
    expect(
      terminalOutput.indexOf("[visible-run] Setting up sandbox"),
    ).toBeLessThan(terminalOutput.indexOf("[visible-run] Agent started"));
    expect(createCalls[0]).not.toHaveProperty("SANDCASTLE_TERMINAL_OUTPUT");
  });

  it("strips GitHub and git credential env for guarded agents", async () => {
    const guardedAgent: AgentProvider = {
      ...terminalOutputAgent,
      gitRemoteGuardrails: true,
      env: {
        OPENCODE_API_KEY: "opencode-key",
        GIT_ASKPASS: "askpass",
      },
    };
    const harness = createTerminalOutputHarness(
      "GH_TOKEN=gh\nGITHUB_TOKEN=github\nGIT_CONFIG_KEY_0=credential.helper\n",
      { agent: guardedAgent },
    );

    await run({
      agent: guardedAgent,
      sandbox: harness.sandbox,
      cwd: harness.dir,
      prompt: "test",
      logging: { type: "stdout" },
    });

    expect(harness.createCalls[0]).toEqual({
      OPENCODE_API_KEY: "opencode-key",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("labels host and sandbox setup hooks in verbose output without changing the run log", async () => {
    const harness = createTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
    );

    const result = await run({
      agent: harness.agent,
      sandbox: harness.sandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      cwd: harness.dir,
      name: "hook-run",
      hooks: {
        host: {
          onSandboxReady: [{ command: "printf host > host-hook.txt" }],
        },
        sandbox: {
          onSandboxReady: [{ command: "printf sandbox > sandbox-hook.txt" }],
        },
      },
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");
    const log = readFileSync(result.logFilePath!, "utf-8");

    expect(terminalOutput).toContain(
      "[hook-run]   [host] printf host > host-hook.txt",
    );
    expect(terminalOutput).toContain(
      "[hook-run]   [sandbox] printf sandbox > sandbox-hook.txt",
    );
    expect(log).toContain("[host] printf host > host-hook.txt");
    expect(log).toContain("printf sandbox > sandbox-hook.txt");
    expect(log).not.toContain("[sandbox] printf sandbox > sandbox-hook.txt");
  });

  it("renders merge-to-head lifecycle output in verbose output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-terminal-merge-"));
    execSync("git init -b main", { cwd: dir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', {
      cwd: dir,
      stdio: "ignore",
    });
    execSync('git config user.name "Test"', { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README.md"), "# Test\n");
    execSync("git add README.md", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, ".sandcastle"), { recursive: true });
    writeFileSync(
      join(dir, ".sandcastle", ".env"),
      "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
    );

    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const sandboxEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(gitTmpDir, ".gitconfig"),
    };
    writeFileSync(sandboxEnv.GIT_CONFIG_GLOBAL, "");
    const streamLines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "committed work <promise>COMPLETE</promise>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        result: "committed work <promise>COMPLETE</promise>",
      }),
    ];
    const sandbox = createBindMountSandboxProvider({
      name: "merge-sandbox",
      create: async (createOptions) => ({
        worktreePath: createOptions.worktreePath,
        exec: async (command, execOptions) => {
          const cwd = execOptions?.cwd ?? createOptions.worktreePath;
          if (command === "mock-agent") {
            writeFileSync(join(cwd, "agent-commit.txt"), "committed\n");
            execSync("git add agent-commit.txt", {
              cwd,
              env: sandboxEnv,
              stdio: "ignore",
            });
            execSync('git commit -m "agent commit"', {
              cwd,
              env: sandboxEnv,
              stdio: "ignore",
            });
            for (const line of streamLines) {
              execOptions?.onLine?.(line);
            }
            return { stdout: streamLines.join("\n"), stderr: "", exitCode: 0 };
          }
          try {
            const stdout = execSync(command, {
              cwd,
              env: sandboxEnv,
              encoding: "utf-8",
            });
            if (execOptions?.onLine) {
              for (const line of stdout.split("\n")) execOptions.onLine(line);
            }
            return { stdout, stderr: "", exitCode: 0 };
          } catch (error) {
            const failed = error as {
              stdout?: Buffer | string;
              stderr?: Buffer | string;
              status?: number;
              message?: string;
            };
            return {
              stdout: String(failed.stdout ?? ""),
              stderr: String(failed.stderr ?? failed.message ?? ""),
              exitCode: failed.status ?? 1,
            };
          }
        },
        copyFileIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    const result = await run({
      agent: terminalOutputAgent,
      sandbox,
      prompt: "do the work",
      branchStrategy: { type: "merge-to-head" },
      cwd: dir,
      name: "merge-run",
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");

    expect(result.commits).toHaveLength(1);
    expect(terminalOutput).toContain("[merge-run] Merging to main");
    expect(terminalOutput).toContain("[merge-run] Collecting commits");
  });

  it("renders parsed Claude Code stream text and tool calls in verbose output", async () => {
    const harness = createTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
      {
        agent: claudeCode("test-model", { captureSessions: false }),
        commandMatches: (command) => command.startsWith("claude "),
        streamLines: [
          JSON.stringify({
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "Preparing work." },
                {
                  type: "tool_use",
                  name: "Bash",
                  input: { command: "npm test" },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "result",
            result: "Finished. <promise>COMPLETE</promise>",
          }),
        ],
      },
    );

    const result = await run({
      agent: harness.agent,
      sandbox: harness.sandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      cwd: harness.dir,
      name: "claude-stream-run",
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");
    const log = readFileSync(result.logFilePath!, "utf-8");

    expect(terminalOutput).toContain("[claude-stream-run] Preparing work.");
    expect(terminalOutput).toContain("[claude-stream-run] Bash(npm test)");
    expect(log).toContain("Preparing work.");
    expect(log).toContain("Bash(npm test)");
  });

  it("renders OpenCode reasoning, text, and tool events in verbose output", async () => {
    const harness = createTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
      {
        agent: opencode("test-model"),
        commandMatches: (command) => command.includes("opencode run "),
        streamLines: [
          JSON.stringify({
            type: "reasoning",
            part: { text: "checking approach" },
          }),
          JSON.stringify({
            type: "tool_use",
            part: { tool: "bash", input: { command: "printf ok" } },
          }),
          JSON.stringify({ type: "step_start" }),
          JSON.stringify({
            type: "text",
            part: { text: "Final answer. <promise>COMPLETE</promise>" },
          }),
          JSON.stringify({
            type: "step_finish",
            part: { reason: "stop" },
          }),
        ],
      },
    );

    const result = await run({
      agent: harness.agent,
      sandbox: harness.sandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      cwd: harness.dir,
      name: "opencode-stream-run",
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");

    expect(result.stdout).toBe("Final answer. <promise>COMPLETE</promise>");
    expect(terminalOutput).toContain(
      "[opencode-stream-run] [thinking] checking approach",
    );
    expect(terminalOutput).toContain("[opencode-stream-run] Bash(printf ok)");
    expect(terminalOutput).toContain(
      "[opencode-stream-run] Final answer. <promise>COMPLETE</promise>",
    );
  });

  it("renders Codex parsed stream events in verbose output", async () => {
    const harness = createTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
      {
        agent: codex("test-model"),
        commandMatches: (command) => command.startsWith("codex "),
        streamLines: [
          JSON.stringify({
            type: "item.started",
            item: { type: "command_execution", command: "npm test" },
          }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Codex finished. <promise>COMPLETE</promise>",
            },
          }),
        ],
      },
    );

    await run({
      agent: harness.agent,
      sandbox: harness.sandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      cwd: harness.dir,
      name: "codex-stream-run",
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");

    expect(terminalOutput).toContain("[codex-stream-run] Bash(npm test)");
    expect(terminalOutput).toContain(
      "[codex-stream-run] Codex finished. <promise>COMPLETE</promise>",
    );
  });

  it("buffers Pi text deltas before rendering verbose output", async () => {
    const textDeltas = [
      "Hello",
      " ",
      "world",
      ". ",
      "This",
      " ",
      "is",
      " ",
      "buffered",
      ".\n",
    ];
    const harness = createTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
      {
        agent: pi("test-model"),
        commandMatches: (command) => command.startsWith("pi "),
        streamLines: [
          ...textDeltas.map((delta) =>
            JSON.stringify({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta },
            }),
          ),
          JSON.stringify({
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [
                  { text: "Done. <promise>COMPLETE</promise>", type: "text" },
                ],
              },
            ],
          }),
        ],
      },
    );

    await run({
      agent: harness.agent,
      sandbox: harness.sandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      cwd: harness.dir,
      name: "pi-stream-run",
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");

    expect(terminalOutput).toContain("[pi-stream-run] Hello world. ");
    expect(terminalOutput).toContain("[pi-stream-run] This is buffered.");
  });

  it("uses process env fallback when the key is declared empty", async () => {
    process.env.SANDCASTLE_TERMINAL_OUTPUT = "verbose";

    const { terminalOutput } = await runTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=\n",
      "fallback-run",
    );

    expect(terminalOutput).toContain("[fallback-run] Sandcastle Run");
    expect(terminalOutput).toContain("[fallback-run] Agent started");
  });

  it("leaves explicit stdout logging out of file-log fan-out", async () => {
    const harness = createTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=verbose\n",
    );

    const result = await run({
      agent: terminalOutputAgent,
      sandbox: harness.sandbox,
      prompt: "do the work",
      branchStrategy: { type: "head" },
      cwd: harness.dir,
      name: "stdout-run",
      logging: { type: "stdout" },
    });
    const terminalOutput = consoleSpy.mock.calls.flat().join("\n");

    expect(result.logFilePath).toBeUndefined();
    expect(terminalOutput).not.toContain("tail -f");
  });

  it("fails invalid values before sandbox setup or run-log fan-out", async () => {
    const harness = createTerminalOutputHarness(
      "SANDCASTLE_TERMINAL_OUTPUT=loud\n",
    );

    await expect(
      run({
        agent: terminalOutputAgent,
        sandbox: harness.sandbox,
        prompt: "do the work",
        branchStrategy: { type: "head" },
        cwd: harness.dir,
        name: "invalid-run",
      }),
    ).rejects.toThrow('Invalid SANDCASTLE_TERMINAL_OUTPUT value "loud"');

    expect(harness.createCalls).toEqual([]);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

describe("formatContextWindowSize", () => {
  it("rounds up to the nearest 1000 tokens", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 102400,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("103k");
  });

  it("returns exact k value when total is a multiple of 1000", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 100000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("100k");
  });

  it("rounds 100001 up to 101k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 100001,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("101k");
  });

  it("rounds 1 up to 1k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("1k");
  });

  it("rounds 999 up to 1k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 999,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("1k");
  });

  it("returns 1k for exactly 1000", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("1k");
  });

  it("rounds 1001 up to 2k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 1001,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("2k");
  });

  it("sums inputTokens, cacheCreationInputTokens, and cacheReadInputTokens", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 50000,
        cacheCreationInputTokens: 25000,
        cacheReadInputTokens: 25000,
        outputTokens: 9999,
      }),
    ).toBe("100k");
  });

  it("rounds 99500 up to 100k", () => {
    expect(
      formatContextWindowSize({
        inputTokens: 99500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe("100k");
  });
});

describe("buildContextWindowLines", () => {
  it("returns one line per iteration with usage data", () => {
    const lines = buildContextWindowLines([
      {
        usage: {
          inputTokens: 50000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1000,
        },
      },
      {
        usage: {
          inputTokens: 100000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 2000,
        },
      },
    ]);
    expect(lines).toEqual(["Context window: 50k", "Context window: 100k"]);
  });

  it("skips iterations without usage data", () => {
    const lines = buildContextWindowLines([
      {
        usage: {
          inputTokens: 50000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 1000,
        },
      },
      {},
      {
        usage: {
          inputTokens: 100000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 2000,
        },
      },
    ]);
    expect(lines).toEqual(["Context window: 50k", "Context window: 100k"]);
  });

  it("returns empty array when no iterations have usage", () => {
    const lines = buildContextWindowLines([{}, {}, {}]);
    expect(lines).toEqual([]);
  });

  it("returns empty array for empty iterations list", () => {
    const lines = buildContextWindowLines([]);
    expect(lines).toEqual([]);
  });
});
