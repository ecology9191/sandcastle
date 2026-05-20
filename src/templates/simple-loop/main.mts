import { exec as execCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import * as sandcastle from "@ecology91/sandcastle";
import { docker } from "@ecology91/sandcastle/sandboxes/docker";

// Simple loop: an agent that picks open backlog issues one by one and closes them.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

const exec = promisify(execCallback);
const humanGateCommand = "{{HUMAN_GATES_COMMAND}}";
const humanGateMaxBuffer = 10 * 1024 * 1024;

const loadSandcastleEnv = (): Record<string, string> => {
  try {
    const env: Record<string, string> = {};
    const content = readFileSync(".sandcastle/.env", "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        value.length >= 2 &&
        ((value[0] === '"' && value[value.length - 1] === '"') ||
          (value[0] === "'" && value[value.length - 1] === "'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
};

const sandcastleEnv = { ...loadSandcastleEnv(), ...process.env };
const codingHarness =
  sandcastleEnv.SANDCASTLE_CODING_HARNESS ?? "{{CODING_HARNESS}}";
const codingModel = sandcastleEnv.SANDCASTLE_MODEL ?? "{{CODING_MODEL}}";

const createCodingAgent = (): sandcastle.AgentProvider => {
  switch (codingHarness) {
    case "claude":
    case "claude-code":
      return sandcastle.claudeCode(codingModel);
    case "pi":
      return sandcastle.pi(codingModel);
    case "codex":
      return sandcastle.codex(codingModel);
    case "opencode":
      return sandcastle.opencode(codingModel);
    default:
      throw new Error(
        `Unsupported SANDCASTLE_CODING_HARNESS "${codingHarness}". Expected claude-code, pi, codex, or opencode.`,
      );
  }
};

type HumanGateIssue = {
  id?: string;
  number?: number;
  title?: string;
  status?: string;
  defer_until?: string;
  labels?: ({ name?: string } | string)[];
};

const hasHumanGateLabel = (issue: HumanGateIssue): boolean =>
  issue.labels?.some((label) => {
    const name = typeof label === "string" ? label : label.name;

    return name === "ready-for-human";
  }) ?? false;

const filterHumanGateIssues = (issues: HumanGateIssue[]): HumanGateIssue[] =>
  issues.filter(hasHumanGateLabel);

const listHumanGateIssues = async (): Promise<HumanGateIssue[]> => {
  const { stdout } = await exec(humanGateCommand, {
    maxBuffer: humanGateMaxBuffer,
  });
  const trimmed = stdout.trim();

  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("Human gate command must return a JSON array");
  }

  return filterHumanGateIssues(parsed as HumanGateIssue[]);
};

const formatHumanGateIssue = (issue: HumanGateIssue): string => {
  const id =
    issue.id ??
    (issue.number === undefined ? "unknown issue" : `#${issue.number}`);
  const title = issue.title ?? "(untitled)";
  const deferUntil = issue.defer_until
    ? `, deferred until ${issue.defer_until}`
    : "";
  const status = issue.status ? ` (${issue.status}${deferUntil})` : "";

  return `${id}: ${title}${status}`;
};

const stopIfHumanGateOpen = async (): Promise<void> => {
  const humanGateIssues = await listHumanGateIssues();

  if (humanGateIssues.length === 0) {
    return;
  }

  console.error(
    "Human input required. Sandcastle will not plan or run agent work while HITL issues are ready:",
  );

  for (const issue of humanGateIssues) {
    console.error(`  ${formatHumanGateIssue(issue)}`);
  }

  process.exit(1);
};

await stopIfHumanGateOpen();

await sandcastle.run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — Docker is the default runtime.
  sandbox: docker(),

  // The agent provider. Set SANDCASTLE_CODING_HARNESS and SANDCASTLE_MODEL in
  // .sandcastle/.env to switch harnesses or models without editing this file.
  agent: createCodingAgent(),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.sandcastle/prompt.md",

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 3,

  // Branch strategy — merge-to-head creates a temporary branch for the agent
  // to work on, then merges the result back to HEAD when the run completes.
  // This is required when using copyToWorktree, since head mode bind-mounts
  // the host directory directly (no worktree to copy into).
  branchStrategy: { type: "merge-to-head" },

  // Copy node_modules from the host into the worktree before the sandbox
  // starts. The hook below repairs the copied tree only when needed.
  copyToWorktree: ["node_modules"],

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  hooks: {
    sandbox: {
      // onSandboxReady runs once after the sandbox is initialised and the repo is
      // synced in, before the agent starts. Use it to install dependencies or run
      // any other setup steps your project needs.
      onSandboxReady: [
        {
          command:
            "test -d node_modules && npm ls --depth=0 >/dev/null 2>&1 || npm install --prefer-offline --no-audit --no-fund",
        },
      ],
    },
  },
});
