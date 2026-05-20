// Sequential Reviewer — implement-then-review loop
//
// This template drives a two-phase workflow per issue:
//   Phase 1 (Implement): A coding agent picks an open backlog issue, works on it
//                        on a dedicated branch, commits the changes, and signals
//                        completion.
//   Phase 2 (Review):    A second coding agent reviews the branch diff and either
//                        approves it or makes corrections directly on the branch.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration. This is a middle-complexity option between the simple-loop (no review
// gate) and the parallel-planner (concurrent execution with a planning phase).
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import { exec as execCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import * as sandcastle from "@ecology91/sandcastle";
import { docker } from "@ecology91/sandcastle/sandboxes/docker";

const exec = promisify(execCallback);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// Reuse copied dependencies and install only when the package tree is missing or invalid.
const installDependenciesCommand =
  "test -d node_modules && npm ls --depth=0 >/dev/null 2>&1 || npm install --prefer-offline --no-audit --no-fund";

const hooks = {
  sandbox: { onSandboxReady: [{ command: installDependenciesCommand }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. The hook above repairs the copied tree only when needed.
const copyToWorktree = ["node_modules"];

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

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
  await stopIfHumanGateOpen();

  // -------------------------------------------------------------------------
  // Phase 1: Implement
  //
  // A coding agent picks the next open backlog issue, creates a branch, writes
  // the implementation (using RGR: Red → Green → Repeat → Refactor), and
  // commits the result.
  //
  // The agent signals completion via <promise>COMPLETE</promise> when done.
  // The result contains the branch name the agent worked on.
  // -------------------------------------------------------------------------
  const implement = await sandcastle.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: { type: "merge-to-head" },
    name: "implementer",
    maxIterations: 100,
    agent: createCodingAgent(),
    promptFile: "./.sandcastle/implement-prompt.md",
  });

  // Extract the branch the agent worked on so the reviewer can target it.
  const branch = implement.branch;

  if (!implement.commits.length) {
    console.log("Implementation agent made no commits. Skipping review.");
    continue;
  }

  console.log(`\nImplementation complete on branch: ${branch}`);
  console.log(`Commits: ${implement.commits.length}`);

  // -------------------------------------------------------------------------
  // Phase 2: Review
  //
  // A second coding agent reviews the diff of the branch produced by Phase 1.
  // It uses the {{BRANCH}} prompt argument to inspect the right branch, and
  // either approves or makes corrections directly on the branch.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: { type: "branch", branch },
    name: "reviewer",
    maxIterations: 1,
    agent: createCodingAgent(),
    promptFile: "./.sandcastle/review-prompt.md",
    // Prompt arguments substitute {{BRANCH}} in review-prompt.md before the
    // agent sees the prompt.
    promptArgs: {
      BRANCH: branch,
    },
  });

  console.log("\nReview complete.");
}

console.log("\nAll done.");
