# Issue tracker: Beads

Issues and PRDs for this repo live in `.beads/`. Use the `bd` CLI for all operations. `.beads/` must be committed/tracked in git for OpenCode/Sandcastle worktree sandboxes to see it; untracked local Beads state will not appear in worktrees.

## Conventions

- **Issue IDs**: Beads IDs are strings like `bd-a1b2` or hierarchical IDs, never numeric issue numbers. If another skill says `#42`, issue number, or numeric issue reference, use the Beads string ID instead; if only a number is supplied, ask for/search for the Beads ID.
- **Create an issue**: `bd create "Title" --body-file - -t task -p 2 -l needs-triage --json`. Pipe multiline bodies through stdin or a body file, for example `bd create "Title" --body-file - -t task -p 2 -l needs-triage --json < body.md`. `--stdin` is an alias for `--body-file -`.
- **Issue type**: `-t, --type` accepts `bug|feature|task|epic|chore|decision`; default is `task`.
- **Priority**: `-p 2` is Beads' default medium priority. `0` / `P0` is highest; `4` / `P4` is lowest. Sandcastle uses `bd ready --json` for actionable work and does not parse priority itself.
- **Labels**: `-l, --labels` accepts comma-separated labels, for example `-l needs-triage,bug`.
- **Read an issue**: `bd show <ID> --json` and `bd comments <ID> --json`.
- **List actionable work**: `bd ready --json` returns unblocked work that is ready to pick up.
- **List open work**: `bd list --status open --json` returns open issues, including blocked issues; don't use it as a substitute for `bd ready --json`.
- **Add a dependency**: `bd dep add <blocked-issue-id> <blocking-issue-id> --type blocks`. The blocking issue is the second positional argument. `--blocked-by` is also accepted, but prefer the positional form.
- **Comment on an issue**: `bd comments add <ID> "..." --json`. For multiline agent briefs or triage notes, use `bd comments add <ID> -f notes.md --json` or a safely quoted multiline shell string.
- **Apply / remove labels**: `bd label add <ID> <label>` / `bd label remove <ID> <label>`
- **Claim work**: `bd update <ID> --claim --json` when a workflow asks an agent to claim an issue.
- **Close**: `bd close <ID> --reason "..." --json`

## When a skill says "publish to the issue tracker"

Create a Beads issue with `bd create "Title" --body-file - -t task -p 2 -l needs-triage --json`, passing the markdown body on stdin or from a body file.

## When a skill says "fetch the relevant ticket"

Run `bd show <ID> --json` and `bd comments <ID> --json`.

## When the triage skill asks for incoming work

Run `bd list --status open --json`, then inspect relevant issues with `bd show <ID> --json` and `bd comments <ID> --json`. Queue helpers: `bd list --status open --no-labels --json`, `bd list --status open --label needs-triage --json`, and `bd list --status open --label needs-info --json`.

Derive triage buckets from labels and comments:

- **Unlabeled**: open issues with no triage-role label.
- **Needs triage**: issues labeled `needs-triage`.
- **Needs info**: issues labeled `needs-info`; read comments to see what information was requested and whether the reporter has answered.

Process oldest first when timestamp fields are present. For triage transitions, remove existing state-role labels before adding the new mapped triage label. Use `bd label add <ID> <label>`, `bd label remove <ID> <label>`, and `bd comments add <ID> -f notes.md --json` to record transitions. Category labels `bug` and `enhancement` are literal Beads labels unless the repo documents another mapping.
