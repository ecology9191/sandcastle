// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import * as sandcastle from "@ecology91/sandcastle";
import { docker } from "@ecology91/sandcastle/sandboxes/docker";

const exec = promisify(execCallback);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
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

const taskContextCommandTemplate = "{{VIEW_TASK_COMMAND}}";
const taskContextMaxBuffer = 10 * 1024 * 1024;
const humanGateCommand = "{{HUMAN_GATES_COMMAND}}";
const humanGateMaxBuffer = 10 * 1024 * 1024;

type HumanGateIssue = {
  id?: string;
  number?: number;
  title?: string;
  status?: string;
  defer_until?: string;
};

const shellQuote = (value: string): string =>
  "'" + value.replace(/'/g, "'\\''") + "'";

const loadTaskContext = async (taskId: string): Promise<string> => {
  const command = taskContextCommandTemplate.replace(
    /<ID>/g,
    shellQuote(taskId),
  );

  try {
    const { stdout } = await exec(command, { maxBuffer: taskContextMaxBuffer });
    const taskContext = stdout.trim();

    if (!taskContext) {
      throw new Error("Task context command produced no output");
    }

    return taskContext;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load task context for ${taskId}: ${message}`);
  }
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

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
  await stopIfHumanGateOpen();

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — we parse that to drive Phase 2.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code.
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.claudeCode("claude-opus-4-6"),
    promptFile: "./.sandcastle/plan-prompt.md",
  });

  // Extract the <plan>…</plan> block from the agent's stdout.
  const planMatch = plan.stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!planMatch) {
    throw new Error(
      "Planning agent did not produce a <plan> tag.\n\n" + plan.stdout,
    );
  }

  // The plan JSON contains an array of issues, each with id, title, branch.
  const { issues } = JSON.parse(planMatch[1]!) as {
    issues: { id: string; title: string; branch: string }[];
  };

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, load deterministic task context before creating a sandbox.
  // Missing or empty context rejects only that issue before agent launch. Then
  // createSandbox() lets the implementer and reviewer share the same sandbox
  // instance per branch. The implementer runs first; if it produces commits
  // and a completion signal, the reviewer runs in the same sandbox.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const taskContext = await loadTaskContext(issue.id);

      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        sandbox: docker(),
        hooks,
        copyToWorktree,
      });

      try {
        // Run the implementer
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: sandcastle.claudeCode("claude-sonnet-4-6"),
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
            TASK_CONTEXT: taskContext,
          },
        });

        // Only review completed implementer branches with commits.
        if (
          implement.commits.length > 0 &&
          implement.completionSignal !== undefined
        ) {
          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: sandcastle.claudeCode("claude-sonnet-4-6"),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              BRANCH: issue.branch,
            },
          });

          // Keep both run results so implementer and reviewer completion evidence
          // cannot obscure each other during merge eligibility checks.
          return {
            implement,
            review,
            commits: [...implement.commits, ...review.commits],
          };
        }

        if (implement.commits.length > 0) {
          console.warn(
            `  ! Skipped incomplete branch ${issue.branch}: implementer commits present but completion signal missing.`,
          );
        } else if (implement.completionSignal !== undefined) {
          console.log(
            `  - ${issue.branch} implementer completed but produced no commits; skipping review and merge.`,
          );
        }

        return {
          implement,
          review: undefined,
          commits: implement.commits,
        };
      } finally {
        await sandbox.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status !== "fulfilled") {
      continue;
    }

    const issue = issues[i]!;
    const run = outcome.value;

    if (
      run.implement.completionSignal !== undefined &&
      run.implement.commits.length > 0 &&
      run.review !== undefined &&
      run.review.completionSignal === undefined
    ) {
      console.warn(
        `  ! Skipped incomplete review for ${issue.branch}: reviewer completion signal missing.`,
      );
    }
  }

  // Only pass branches with completed implementer and reviewer evidence to the
  // merge phase. Merge eligibility is conservative: implementer commits plus
  // implementer and reviewer completion signals are required. A completed
  // reviewer can approve without making new commits.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.implement.completionSignal !== undefined &&
        entry.outcome.value.implement.commits.length > 0 &&
        entry.outcome.value.review !== undefined &&
        entry.outcome.value.review.completionSignal !== undefined,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} merge-eligible branch(es):`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // All agents ran but none completed both implementation and review.
    console.log("No merge-eligible branches. Nothing to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.claudeCode("claude-sonnet-4-6"),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
