---
name: opencode-empty-output-fix
overview: "Fix the OpenCode empty-output failure in Sandcastle without changing the onboarding flow: newly scaffolded OpenCode sandboxes should work from `npx sandcastle init`, and silent OpenCode exits should fail with a clear agent error."
todos:
  - id: edit-opencode-provider
    content: Expose OpenCode raw stdout as text without changing result semantics.
    status: completed
  - id: fix-opencode-image
    content: Make scaffolded OpenCode sandbox images set OPENCODE_BIN_PATH to a validated native binary symlink during init output.
    status: completed
  - id: add-regression-tests
    content: Add provider, orchestrator, and scaffold tests for stdout logging, empty-output failure, and init-generated image setup.
    status: completed
  - id: add-changeset-verify
    content: Add a patch changeset and run targeted tests, typecheck, and full tests where practical.
    status: completed
isProject: false
---

# Fix OpenCode Silent Empty Output

## Scope

- Update the generated OpenCode sandbox image in [`src/InitService.ts`](/home/user/Projects/sandcastle/sandcastle/src/InitService.ts) so `npx sandcastle init --agent opencode` scaffolds a Dockerfile/Containerfile that works without local hand edits. After `npm install -g opencode-ai@latest`, the image should find the installed native `opencode` binary, create a stable symlink such as `/usr/local/bin/opencode-native`, validate it during build, and set `OPENCODE_BIN_PATH` to that symlink.
- Update the built-in OpenCode **agent provider** in [`src/AgentProvider.ts`](/home/user/Projects/sandcastle/sandcastle/src/AgentProvider.ts) so raw OpenCode stdout is surfaced as text in log-to-file mode. This preserves the existing return behavior because `invokeAgent()` still falls back to raw stdout for the final result.
- Add a narrow OpenCode-only guard in [`src/Orchestrator.ts`](/home/user/Projects/sandcastle/sandcastle/src/Orchestrator.ts): if OpenCode exits `0` with no parsed result, no stdout, and no stderr, fail immediately with an `AgentError` such as `opencode produced no output`. Do not add a new public `AgentProvider` field or change behavior for Claude Code, Codex, Pi, or custom providers.

## Shape Of The Image Fix

- Keep the fix inside the scaffolded OpenCode image, not in user `.sandcastle/main.ts`, so existing templates and the JS API stay the same.
- Avoid a hard-coded `linux-x64-baseline` command path. Prefer a build-time discovery step over the installed `opencode-*` package directory, then symlink the discovered binary to one predictable path.
- Keep the Dockerfile lines explicit and readable. No nested shell conditionals beyond what is needed to fail the build if the native binary cannot be found.

## Regression Coverage

- Update [`src/AgentProvider.test.ts`](/home/user/Projects/sandcastle/sandcastle/src/AgentProvider.test.ts) for OpenCode stdout passthrough.
- Add an [`src/Orchestrator.test.ts`](/home/user/Projects/sandcastle/sandcastle/src/Orchestrator.test.ts) regression for the exact silent wrapper shape: OpenCode command returns `{ stdout: "", stderr: "", exitCode: 0 }` and orchestration fails with `AgentError`.
- Update [`src/InitService.test.ts`](/home/user/Projects/sandcastle/sandcastle/src/InitService.test.ts) to assert scaffolded OpenCode Dockerfile/Containerfile sets `OPENCODE_BIN_PATH`, creates the native symlink, and validates the binary. This locks the fix to the `npx sandcastle init` onboarding path.
- Add a patch changeset in [`.changeset/`](/home/user/Projects/sandcastle/sandcastle/.changeset) for `@ecology91/sandcastle`. README changes are probably not needed because this is a bug fix to existing behavior, not new documented usage.

## Verification

- Run targeted Vitest files first: `npm run test -- src/AgentProvider.test.ts src/Orchestrator.test.ts src/InitService.test.ts`.
- Run the repo checks required here: `npm run typecheck` and, if targeted tests are clean, `npm run test`.

## Implementation Note

Because the orchestration skill is active for code fixes, after approval I’ll delegate the code edit to a GPT-5.5 Extra High subagent, then inspect the diff and run verification locally before reporting back.
