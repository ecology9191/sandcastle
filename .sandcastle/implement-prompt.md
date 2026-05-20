# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Use the authoritative task context below. It was loaded from Beads before launch.

<task-context>

{{TASK_CONTEXT}}

</task-context>

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits after completing the verification step below.

# CONTEXT

Do not preload commit history. If commit style is needed, run `git log --oneline -3` and summarize only the relevant pattern.

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

Use red-green-refactor when applicable: write one failing test, implement the smallest passing change, repeat until done, then refactor.

# FEEDBACK LOOPS

Before committing, run `npm run typecheck` and `npm run test` to ensure the tests pass.

# COMMIT

Make one git commit. Use a concise `RALPH:` subject that includes the task ID and outcome.

Commit body is optional. If useful, keep it to at most 3 bullets: why, key decision, validation.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
