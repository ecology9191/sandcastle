# Output streaming plan discussion

_Exported on 5/7/2026 at 08:04:29 UTC from Cursor (3.2.21)_

---

**User**

@/home/user/.cursor/plans/opencode-output-streaming_55690390.plan.md /grill-me

---

**Cursor**

I’ll read the plan first, then I’ll verify any answerable codebase facts before asking the first design question with my recommended answer.

I’ve got the plan. I’m checking the current provider/orchestrator shape so the first question is about a real unresolved choice, not something the code already answers.

The code confirms OpenCode is currently the only raw stdout passthrough provider, while Claude/Pi already avoid prompt-in-argv with stdin and the orchestrator currently treats “no result event” as permission to fall back to raw stdout.

**OpenCode Streaming Plan**

> **Should this change keep OpenCode prompts in argv after `--`, as the plan currently says, or should we also move OpenCode prompts to `stdin` in this same change if `opencode run` supports it? My recommendation: keep argv in this pass and only use `--` separation, because this plan is about output semantics and changing prompt transport is a separate CLI-compatibility risk unless we verify OpenCode stdin behavior first.**
>
> - Keep prompts in argv after `--` for this change.
> - Move OpenCode prompts to stdin in this change if supported.
> - First verify OpenCode stdin support, then decide. ✔

Good, I’ll verify that before treating it as settled. I’m going to check the local OpenCode CLI help first, and only run a harmless probe if the help leaves it ambiguous.

The local help describes `message` only as positional arguments and does not mention stdin. I’m checking the installed CLI wrapper/source next so we don’t infer too much from help text alone.

Verification result: installed OpenCode is `1.14.40`, and current docs plus a closed regression issue confirm `opencode run` reads stdin when no positional message is provided. I’d update the plan to pass OpenCode prompts via `stdin` rather than argv, keeping `--` only if a positional fallback remains.

**OpenCode Streaming Plan**

> **Should visible OpenCode `reasoning` be emitted through the existing `text` stream event with a `[thinking]` prefix, or should Sandcastle add a distinct stream/display event type for thinking? My recommendation: do not add a new public event type in this change. Emit it as existing display text with a clear prefix, but keep it out of `run().stdout` and final result state, because the plan’s main value is clean result semantics with a small interface change.**
>
> - Use existing text events with a `[thinking]` prefix. ✔
> - Add a distinct thinking/reasoning event type.
> - Do not display reasoning at all.

That lines up with the current event model. I’m checking the stream event consumers before the next question, because the risk is whether prefixed thinking text could leak into APIs that callers treat as assistant answer.

**OpenCode Streaming Plan**

> **Where should the OpenCode clean-exit/no-`step_finish` fallback live: inside the per-run OpenCode parser’s `finish()` method, or in `Orchestrator.invokeAgent()` as provider-specific logic? My recommendation: keep it inside `finish()`. The orchestrator should only call `finish({ exitCode })` and dispatch returned parsed events; OpenCode-specific choices like “current step beats earlier fallback” belong with the parser state.**
>
> - Put OpenCode finalization in the parser `finish()` method.
> - Put OpenCode finalization in provider-specific orchestrator logic.
> - Do not implement a clean-exit fallback without `step_finish`.
>
> Answer: Can you explain to me what those both mean in laymans terms and then ask again?

In plain terms: OpenCode sends a stream of little messages, and sometimes the final “I’m done” message may be missing. The question is whether the OpenCode-specific parser should decide what final answer to return from the messages it saw, or whether the central orchestrator should contain special OpenCode cleanup rules. My recommendation is still: keep that decision in the OpenCode parser, so the orchestrator stays generic.

**OpenCode Streaming Plan**

> **If OpenCode exits cleanly but never sends the final `step_finish` event, who should decide the final answer from the stream seen so far? My recommendation: the per-run OpenCode parser should decide, because it owns the OpenCode-specific state and rules.**
>
> - The per-run OpenCode parser decides the fallback final answer. ✔
> - The central orchestrator decides with special OpenCode logic.
> - Treat missing final `step_finish` as failure instead of guessing.

Great, that keeps the special OpenCode stream rules contained. Next I’m going after the failure-mode question, because it determines whether this stays strict or quietly preserves today’s raw-stdout behavior.

**OpenCode Streaming Plan**

> **If Sandcastle asks OpenCode for `--format json` but the process exits `0` and outputs non-JSON/formatted text, should Sandcastle fail the run or fall back to treating that text as the assistant result? My recommendation: fail the run clearly. Falling back would reintroduce exactly the stdout/completion-signal pollution this plan is trying to remove.**
>
> - Fail clearly on successful non-JSON output after requesting JSON. ✔
> - Fallback to raw stdout as the assistant result.
> - Fallback to raw stdout but log/display a warning.

**OpenCode Streaming Plan**

> **The plan has a tension: it says non-JSON output after `--format json` should fail closed, but also says malformed JSON lines are ignored. Should a successful OpenCode JSON run fail if it contains any non-empty malformed/non-JSON stdout line, even if other valid JSON events were parsed? My recommendation: yes, fail on any non-empty malformed/non-JSON stdout line for `opencode --format json`, while still ignoring empty lines and unknown-but-valid JSON event types. That makes the contract crisp and prevents hidden stdout pollution.**
>
> - Fail on any non-empty malformed/non-JSON stdout line.
> - Ignore malformed/non-JSON lines as long as at least one valid JSON event was parsed.
> - Ignore all malformed/non-JSON lines and only fail if no final result is found.
>
> Answer: Layman terms again. Then ask the question again

Layman version: if we order a machine-readable receipt from OpenCode, but one line comes back as ordinary human text or garbled text, do we treat that as “the machine broke its contract” or just ignore that bad line and keep going? My recommendation is to fail if any non-empty bad line appears, because otherwise a random text line could hide the exact pollution this change is trying to prevent.

**OpenCode Streaming Plan**

> **When `opencode --format json` returns mostly valid JSON lines but also one non-empty plain-text/garbled line, what should Sandcastle do? My recommendation: fail the run clearly, while ignoring blank lines and unknown valid JSON event types.**
>
> - Fail the run if any non-empty line is not valid JSON. ✔
> - Ignore the bad line if the rest of the JSON stream is usable.
> - Always ignore bad lines.

That tightens the plan: malformed/non-JSON stdout becomes an incompatibility signal, not a skipped line. I’m checking OpenCode event/tool shapes briefly before asking about the tool-call allowlist.

OpenCode’s common tool list is broader than Sandcastle’s current display allowlist: `bash`, `read`, `write`, `edit`, `glob`, `grep`, `webfetch`, `websearch`, and `task`. The risky part is that write/edit can carry large or sensitive content in inputs, while read/glob/grep are usually compact observability.

**OpenCode Streaming Plan**

> **Which OpenCode tools should this first implementation display as tool calls? My recommendation: display `bash`, `websearch`, `webfetch`, `task`, plus read-only navigation tools `read`, `glob`, and `grep`; exclude `write` and `edit` for now unless we define carefully redacted summaries, because their inputs can include file contents or patches.**
>
> - Only the plan’s four tools: bash, websearch, webfetch, task.
> - Four tools plus read/glob/grep, excluding write/edit.
> - All common OpenCode tools including write/edit.
> - Do not display OpenCode tool calls in this pass.
>
> Answer: Laymans again then ask question

Layman version: when OpenCode uses tools, Sandcastle can show little status lines like “Bash: npm test” or “Grep: TODO”. The choice is whether we show only a few low-risk tools, also show file-search/read tools, or show every tool including write/edit actions that may contain lots of code or sensitive text in their inputs. My recommendation is to show the useful low-risk set now, and leave write/edit summaries for a later, more careful pass.

**OpenCode Streaming Plan**

> **Which OpenCode tool calls should Sandcastle show in the UI/log stream in this first change? My recommendation: show bash/websearch/webfetch/task plus read/glob/grep, but do not show write/edit yet.**
>
> - Show only bash, websearch, webfetch, and task.
> - Show bash, websearch, webfetch, task, read, glob, and grep; skip write/edit.
> - Show all common tools, including write and edit.
> - Skip OpenCode tool-call display for now.
>
> Answer: Choose B. But make a bead issue about a potential feature implementation showing all common tools including write and edit to be reviewed sometime

Choice B recorded. Since you also asked for a follow-up issue, I’m checking the repo’s issue workflow before I create anything, then I’ll continue the design grilling.

Created Beads issue `sandcastle-l5l` for the future write/edit summaries. The CLI warned that its auto-export `git add` failed, so I’m verifying the bead exists before continuing.

`bd show` confirms `sandcastle-l5l` exists with the follow-up scope. Next question is about what to display when a tool event has no clean input field.

**OpenCode Streaming Plan**

> **For an allowlisted OpenCode tool call, if Sandcastle cannot find a known safe input field such as command/query/url/path/pattern, should it fall back to `part.state.title` or skip displaying that tool call? My recommendation: use `part.state.title` as a display-only fallback, but never use `state.output`, `state.metadata.output`, raw input objects, or JSON-stringified fallback args.**
>
> - Use `part.state.title` as the display-only fallback.
> - Skip the tool call unless a known safe input field is present.
> - Display a JSON-stringified input object as fallback.
>
> Answer: What is part.state.title look like? List an example of all of the options of what they'd look like and ask again. Also is this for the ClackDisplay or the stdout parsing?

Good catch. I’m checking the display formatter so I can explain exactly where this appears and keep the stdout/result path separate.

This is for display/log streaming, not returned stdout. The parser would turn an OpenCode `tool_use` JSON line into a Sandcastle `tool_call` event; `Orchestrator` sends that to `ClackDisplay`, `FileDisplay`, and `onAgentStreamEvent`. It should never affect `run().stdout`, `<plan>` extraction, or completion detection.

Example OpenCode event shape:

```json
{
  "type": "tool_use",
  "part": {
    "tool": "bash",
    "state": {
      "input": { "command": "npm test", "description": "Run tests" },
      "title": "Run tests",
      "output": "test output..."
    }
  }
}
```

How the choices would look in the UI/log:

- Known safe field: `Bash(npm test)`
- `part.state.title` fallback: `Bash(Run tests)`
- Skip: no `Bash(...)` line appears
- JSON stringify fallback: `Bash({"command":"npm test","description":"Run tests"})`

My recommendation is known safe fields first, then `title` fallback, and never stringify raw input or show output fields.

**OpenCode Streaming Plan**

> **For allowlisted OpenCode tools, if a known safe field is missing, should Sandcastle use `part.state.title` as a display-only fallback or skip the tool call? My recommendation: use the title fallback, but never use output fields or raw JSON-stringified input.**
>
> - Use `part.state.title` as the display-only fallback. ✔
> - Skip the tool call unless a known safe input field is present.
> - Use JSON-stringified input as the fallback.

Good. That means tool calls stay informative without letting raw OpenCode payloads leak into display. Next is about OpenCode session IDs, because the JSON stream includes them but Sandcastle’s session capture is currently Claude-specific.

**OpenCode Streaming Plan**

> **Should this change surface OpenCode `sessionID` values in Sandcastle’s `IterationResult.sessionId`, or ignore them until OpenCode resume/capture support is intentionally designed? My recommendation: ignore them in this change. Today `sessionId` is documented and wired around Claude session capture, and exposing OpenCode IDs without resume/capture semantics would create a half-supported public contract.**
>
> - Ignore OpenCode sessionID for now.
> - Surface OpenCode sessionID in IterationResult, but no capture/resume.
> - Implement OpenCode capture/resume support in this change.

---

**User**

Layman terms again. Then ask again

---

**Cursor**

Layman version: OpenCode includes a run ID in its stream. We can either ignore it for now, show it as a Sandcastle session ID even though Sandcastle can’t resume or save that OpenCode session yet, or build full OpenCode session support now. My recommendation is to ignore it for this change so we don’t advertise a half-working feature.

**OpenCode Streaming Plan**

> **What should Sandcastle do with OpenCode’s `sessionID` values in this streaming change? My recommendation: ignore them for now, because session capture/resume is currently Claude-specific and OpenCode support would need its own design.**
>
> - Ignore OpenCode sessionID values for now.
> - Expose the OpenCode sessionID, but do not support capture/resume.
> - Add full OpenCode session capture/resume support now.
>
> Answer: What exactly is the dilemma here? I don't understand please give me a bit of a background story here. Then ask again

Background story: Sandcastle has a public-ish result object with `iterations[].sessionId`. Right now that field is mainly for Claude Code: Sandcastle sees Claude’s session ID, copies the Claude session JSONL out of the sandbox, and later can resume from that session. So for Claude, “sessionId” is not just a label; it means “we captured something useful and can potentially resume it.”

OpenCode’s JSON stream also includes a `sessionID`, like `ses_abc123`. The dilemma is whether Sandcastle should start putting that OpenCode ID into the same `sessionId` field. If we do, users may reasonably expect the same behavior Claude has: session files captured, resume working, maybe `sessionFilePath` populated. But this plan is only about output streaming and clean stdout, not OpenCode session storage/resume.

So the conservative choice is: parse OpenCode’s stream for text/tools/results, but do not surface OpenCode `sessionID` yet. Later, a separate feature can define what OpenCode session capture/resume should mean.

**OpenCode Streaming Plan**

> **Given that background, what should Sandcastle do with OpenCode’s `sessionID` values in this streaming change? My recommendation: ignore them for now so `sessionId` continues to mean a captured/resumable session, not just a raw ID from the stream.**
>
> - Ignore OpenCode sessionID values for now.
> - Expose the OpenCode sessionID even without capture/resume support.
> - Add full OpenCode session capture/resume support in this change.
>
> Answer: Choose A. and Make a bead issue about it to investigate later

Choice A recorded. I’ll create a small Beads follow-up for OpenCode session capture/resume investigation, then keep grilling the remaining implementation choices.

Created `sandcastle-df6` for OpenCode session capture/resume investigation. Beads again warned about auto-export `git add`, so I’ll verify the issue record exists before moving on.

**OpenCode Streaming Plan**

> **If OpenCode emits visible reasoning in chunks, how should the `[thinking]` prefix be applied? My recommendation: prefix each reasoning event as `[thinking] ${text}`. It is a little repetitive for many chunks, but it is simple, stateless for display, and makes every forwarded/logged chunk unmistakably non-result text.**
>
> - Prefix every reasoning event: `[thinking] ...`. ✔
> - Prefix only the first reasoning event per assistant step.
> - Emit start/end markers around a thinking block.

That makes thinking display unambiguous even if chunks are buffered or forwarded independently. Next dilemma is about direct callers of the provider parser versus Sandcastle’s normal orchestrator path.

**OpenCode Streaming Plan**

> **What should `opencode().parseStreamLine()` do for direct callers after we add `createStreamParser()` for the real per-run stateful behavior? My recommendation: make `parseStreamLine()` parse a single OpenCode JSON line for display events only, with no cross-line final-result semantics; document/tests should use `createStreamParser()` for correct OpenCode run results. Keeping raw passthrough would preserve old direct-call behavior but conflict with the new JSON command contract.**
>
> - Parse single JSON lines for display events; use `createStreamParser()` for full results.
> - Keep `parseStreamLine()` as legacy raw stdout passthrough.
> - Make provider-level `parseStreamLine()` stateful too.
>
> Answer: In laymans terms please. Then ask again. Like.,. what is a direct caller?

Layman version: the normal Sandcastle path is “run an agent through the orchestrator,” and that will get a fresh OpenCode parser for each run. A “direct caller” is someone using the exported provider object by itself in code, like `opencode("model").parseStreamLine(line)`, without the orchestrator.

The dilemma: the new OpenCode behavior needs memory across multiple lines to know the final answer. A one-line helper can show “this line is assistant text” or “this line is a tool call,” but it can’t reliably know the final answer because that depends on previous and later lines. We can either make the old one-line helper a limited JSON parser, keep its old raw-text behavior, or make it secretly remember state on the provider object, which is the leak this plan is trying to avoid. My recommendation is the limited JSON parser: useful for simple display tests, but full result behavior requires the new per-run parser.

**OpenCode Streaming Plan**

> **For people who call `opencode().parseStreamLine(line)` directly instead of using the orchestrator, what behavior should it have after this change? My recommendation: parse individual JSON lines for display events only, and require `createStreamParser()` for full final-answer behavior.**
>
> - Parse one JSON line at a time for display events only. ✔
> - Keep the old behavior: every raw stdout line becomes display text.
> - Let the provider object remember state across direct calls too.

That settles the compatibility boundary: direct parsing stays useful but not authoritative for final answer semantics. I’m circling back to the prompt transport decision now that we verified local OpenCode stdin support.

**OpenCode Streaming Plan**

> **If OpenCode produces valid JSON events but no assistant answer text, should Sandcastle treat that as a successful empty result or fail as “no output”? My recommendation: successful empty result for structured JSON runs. It avoids falling back to raw JSONL and lets tool-only or reasoning-only runs have clean stdout semantics, while truly non-JSON/no-output cases can still fail.**
>
> - Treat valid structured no-answer runs as successful empty stdout.
> - Fail valid structured runs if there is no assistant answer text.
> - Fallback to raw JSONL stdout when answer text is empty.
>
> Answer: But for these operations, wouldn't the agent will ALWAYS produce text as it's required for them for some or all phases, am I wrong? Check the implement-prompt.md merge-prompt.md plan-prompt.md and review-plan prompt.md first. Use multiple GPT-5.5 Extra High sub-agents then get back to me

**OpenCode Streaming Plan**

> **Given that normal Sandcastle prompts should produce `<plan>` or `<promise>` text, how should OpenCode structured runs with valid JSON but no final assistant text behave? My recommendation: return successful empty stdout at the parser/orchestrator layer, never raw JSONL; then phase-specific contracts catch missing `<plan>` or missing completion. This keeps the core API defensive without pretending raw logs are an answer.**
>
> - Return successful empty stdout; let missing tags/completion be handled by higher-level phase logic.
> - Fail OpenCode runs if valid JSON contains no final assistant text.
> - Fallback to raw JSONL stdout when no assistant text is found.
