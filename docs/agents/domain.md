# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This repo uses a single-context layout:

- `CONTEXT.md` at the repo root contains the project domain language.
- `docs/adr/` at the repo root contains architectural decision records.

## Before exploring, read these

Read `CONTEXT.md` before making terminology-heavy changes or writing issue titles, refactor proposals, hypotheses, or tests.

Read ADRs in `docs/adr/` that touch the area you're about to work in.

If any of these files don't exist, proceed silently. Don't flag their absence or suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use, or there's a real gap to note for `/grill-with-docs`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding.
