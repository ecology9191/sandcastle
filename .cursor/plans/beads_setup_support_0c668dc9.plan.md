---
name: beads setup support
overview: Add first-class Beads (`bd`) issue tracker support to the setup skill, and fix the small Sandcastle Beads close-command mismatch so the generated skill guidance matches Sandcastle/OpenCode workflows.
todos:
  - id: setup-skill-beads
    content: Update setup skill flow to detect and offer Beads as a first-class issue tracker.
    status: completed
  - id: beads-template
    content: Add issue-tracker-beads.md with commands that satisfy to-issues, to-prd, triage, and Sandcastle/OpenCode workflows.
    status: completed
  - id: sandcastle-close
    content: Fix Sandcastle's Beads close command to use --reason and update scaffold tests.
    status: completed
  - id: changeset-verify
    content: Add a patch changeset and run typecheck plus focused InitService tests.
    status: completed
isProject: false
---

# Add Beads Support To Setup Skill

## Research Decision

- Use [`/home/user/.agents/skills/setup-matt-pocock-skills/issue-tracker-github.md`](/home/user/.agents/skills/setup-matt-pocock-skills/issue-tracker-github.md) as the structural base for the new Beads template because it is the cleanest command-oriented skeleton.
- Do not copy GitHub semantics. Beads needs local Dolt-backed storage, string IDs, dependency-aware ready work, JSON-first commands, Beads comments, and Beads labels.
- Treat [`/home/user/Projects/sandcastle/sandcastle/src/InitService.ts`](/home/user/Projects/sandcastle/sandcastle/src/InitService.ts) as the Sandcastle contract: Beads ingestion is `bd ready --json`, task inspection is `bd show <ID>`, and close should use the current Beads-supported reason flag.

## Implementation Steps

- Update [`/home/user/.agents/skills/setup-matt-pocock-skills/SKILL.md`](/home/user/.agents/skills/setup-matt-pocock-skills/SKILL.md) so Beads is first-class in setup:
  - Explore `.beads/`, `bd` availability, and existing `.sandcastle/` prompt/config clues such as `bd ready --json`.
  - Prefer Beads when `.beads/` already exists or Sandcastle is already scaffolded with Beads; otherwise still offer GitHub, GitLab, Beads, local markdown, and other.
  - Add Beads to the decision explainer and to the seed template list.
- Add [`/home/user/.agents/skills/setup-matt-pocock-skills/issue-tracker-beads.md`](/home/user/.agents/skills/setup-matt-pocock-skills/issue-tracker-beads.md) with exact commands for downstream skills:
  - `bd ready --json` for actionable/unblocked work, distinct from `bd list --status open --json`.
  - `bd show <ID> --json` and `bd comments <ID> --json` when fetching issue context.
  - `bd create "Title" --description=- -t task -p 2 -l needs-triage --json` for `/to-issues` and `/to-prd` publishing, using stdin/body files for multiline bodies.
  - `bd dep add <issue-id> --blocked-by <blocking-id> --type blocks` for dependency relationships.
  - `bd label add/remove <ID> <label>` and `bd comments add <ID> "..."` for `/triage` label and comment behavior.
  - `bd update <ID> --claim --json` for agent claiming where the workflow asks for it.
  - `bd close <ID> --reason "..." --json` for completion.
  - Be explicit that Beads IDs are strings like `bd-a1b2` or hierarchical IDs, never numeric issue numbers.
- Patch Sandcastle’s Beads close command in [`/home/user/Projects/sandcastle/sandcastle/src/InitService.ts`](/home/user/Projects/sandcastle/sandcastle/src/InitService.ts) from positional reason text to `--reason`, because installed `bd` help and upstream docs both support `bd close <ID> --reason "..."`.
- Update focused Sandcastle tests in [`/home/user/Projects/sandcastle/sandcastle/src/InitService.test.ts`](/home/user/Projects/sandcastle/sandcastle/src/InitService.test.ts) so Beads scaffold assertions check the `--reason` close shape.
- Add a patch changeset under [`/home/user/Projects/sandcastle/sandcastle/.changeset/`](/home/user/Projects/sandcastle/sandcastle/.changeset/) for `@ai-hero/sandcastle`, because the Sandcastle scaffolded command is public-facing behavior.

## Verification

- Read lints for edited files after changes.
- Run `npm run typecheck` from [`/home/user/Projects/sandcastle/sandcastle`](/home/user/Projects/sandcastle/sandcastle).
- Run `npm run test -- src/InitService.test.ts` for the focused scaffold coverage.
- I will not run `bd init` or create Beads issues during verification; command syntax was checked through `bd --help` and upstream docs.

## Execution Model

- After plan approval, use GPT-5.5 Extra High subagents for edits per the orchestrator skill:
  - One subagent for the setup skill markdown/template changes.
  - One subagent for the Sandcastle close-command/test/changeset compatibility patch.
  - Parent agent reviews and synthesizes results before final verification.
