import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { run, claudeCode } from "@ecology91/sandcastle";
import { docker } from "@ecology91/sandcastle/sandboxes/docker";

// Simple loop: an agent that picks open backlog issues one by one and closes them.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

const exec = promisify(execCallback);
const humanGateCommand = "{{HUMAN_GATES_COMMAND}}";
const humanGateMaxBuffer = 10 * 1024 * 1024;

type HumanGateIssue = {
  id?: string;
  number?: number;
  title?: string;
  status?: string;
  defer_until?: string;
};

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

  return parsed as HumanGateIssue[];
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
    "Human input required. Sandcastle will not plan or run agent work while HITL issues are open or deferred:",
  );

  for (const issue of humanGateIssues) {
    console.error(`  ${formatHumanGateIssue(issue)}`);
  }

  process.exit(1);
};

await stopIfHumanGateOpen();

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — Docker is the default runtime.
  sandbox: docker(),

  // The agent provider. Pass a model string to claudeCode() — sonnet balances
  // capability and speed for most tasks. Switch to claude-opus-4-6 for harder
  // problems, or claude-haiku-4-5-20251001 for speed.
  agent: claudeCode("claude-sonnet-4-6"),

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
  // starts. This avoids a full npm install from scratch on every iteration.
  // The onSandboxReady hook still runs npm install as a safety net to handle
  // platform-specific binaries and any packages added since the last copy.
  copyToWorktree: ["node_modules"],

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  hooks: {
    sandbox: {
      // onSandboxReady runs once after the sandbox is initialised and the repo is
      // synced in, before the agent starts. Use it to install dependencies or run
      // any other setup steps your project needs.
      onSandboxReady: [{ command: "npm install" }],
    },
  },
});
