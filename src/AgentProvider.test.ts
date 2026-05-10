import { describe, expect, it } from "vitest";
import { claudeCode, codex, opencode, pi } from "./AgentProvider.js";
import type { AgentCommandOptions } from "./AgentProvider.js";

/** Shorthand: build options with dangerouslySkipPermissions: true (mirrors existing sandbox callers). */
const opts = (prompt: string): AgentCommandOptions => ({
  prompt,
  dangerouslySkipPermissions: true,
});

describe("claudeCode factory", () => {
  it("returns a provider with name 'claude-code'", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.name).toBe("claude-code");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model", () => {
    const provider = claudeCode("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--print");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-p -");
    expect(command).not.toContain("'do something'");
    expect(stdin).toBe("do something");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-opus-4-6'");
  });

  it("parseStreamLine extracts text from assistant message", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts result from result message", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
      },
    ]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine extracts tool_use block (Bash → command arg)", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine bakes model into each provider instance independently", () => {
    const provider1 = claudeCode("model-a");
    const provider2 = claudeCode("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  it("buildPrintCommand includes --effort when specified", () => {
    const provider = claudeCode("claude-opus-4-6", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--effort high");
  });

  it("buildPrintCommand omits --effort when not specified", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("buildPrintCommand omits --effort when options is empty", () => {
    const provider = claudeCode("claude-opus-4-6", {});
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--effort");
  });

  it("supports all effort levels", () => {
    for (const effort of ["low", "medium", "high", "max"] as const) {
      const provider = claudeCode("claude-opus-4-6", { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `--effort ${effort}`,
      );
    }
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = claudeCode("claude-opus-4-6", {
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    expect(provider.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.env).toEqual({});
  });

  // --- dangerouslySkipPermissions conditional tests ---

  it("buildPrintCommand includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("parseStreamLine emits session_id from Claude Code init line", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "session_id", sessionId: "abc-123-def" },
    ]);
  });

  it("parseStreamLine ignores system events without subtype init", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "other",
      session_id: "abc-123-def",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine ignores system init without session_id", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("buildPrintCommand includes --resume when resumeSession is set", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).toContain("--resume 'abc-123'");
  });

  it("buildPrintCommand omits --resume when resumeSession is not set", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(command).not.toContain("--resume");
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs includes --dangerously-skip-permissions when true", () => {
    const provider = claudeCode("claude-opus-4-6");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: true,
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("buildInteractiveArgs omits --dangerously-skip-permissions when false", () => {
    const provider = claudeCode("claude-opus-4-6");
    const args = provider.buildInteractiveArgs!({
      prompt: "test",
      dangerouslySkipPermissions: false,
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

// ---------------------------------------------------------------------------
// pi factory
// ---------------------------------------------------------------------------

describe("pi factory", () => {
  it("returns a provider with name 'pi'", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.name).toBe("pi");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and pi flags", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--mode json");
    expect(command).toContain("--no-session");
    expect(command).toContain("-p");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command, stdin } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).not.toContain("it's a test");
    expect(stdin).toBe("it's a test");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'claude-sonnet-4-6'");
  });

  it("parseStreamLine extracts text from message_update event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello world" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool_execution_start event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "Bash",
      args: { command: "npm test" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine skips non-allowlisted tools", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "UnknownTool",
      args: { foo: "bar" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts result from agent_end event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "Do the thing" }] },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Final answer <promise>COMPLETE</promise>",
            },
          ],
        },
      ],
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
      },
    ]);
  });

  it("parseStreamLine does not emit session_id for system init lines", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine handles message_update with missing content", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "message_update" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles tool_execution_start with missing fields", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolName: "Bash",
      // no args field
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = pi("model-a");
    const provider2 = pi("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  it("parseStreamLine captures agent_error event with string error as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      error: "Authentication failed: invalid API key",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Authentication failed: invalid API key",
      },
    ]);
  });

  it("parseStreamLine captures agent_error event with object error as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      error: { message: "Rate limit exceeded", code: "rate_limit" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Rate limit exceeded",
      },
    ]);
  });

  it("parseStreamLine captures error event with string message as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      message: "Internal server error",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Internal server error",
      },
    ]);
  });

  it("parseStreamLine captures error event with string error field as result", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      error: "Connection refused",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Connection refused",
      },
    ]);
  });

  it("parseStreamLine returns empty array for agent_error with no extractable message", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_error",
      // no error field
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for error event with no extractable message", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "error",
      // no message or error field
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = pi("claude-sonnet-4-6", { env: { PI_KEY: "abc" } });
    expect(provider.env).toEqual({ PI_KEY: "abc" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.env).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// codex factory
// ---------------------------------------------------------------------------

describe("codex factory", () => {
  it("returns a provider with name 'codex'", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.name).toBe("codex");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and --json flag", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("gpt-5.4-mini");
    expect(command).toContain("--json");
  });

  it("buildPrintCommand delivers prompt via stdin, not argv", () => {
    const provider = codex("gpt-5.4-mini");
    const { command, stdin } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).not.toContain("it's a test");
    expect(stdin).toBe("it's a test");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("-m 'gpt-5.4-mini'");
  });

  it("buildPrintCommand includes model reasoning effort config when specified", () => {
    const provider = codex("gpt-5.4-mini", { effort: "high" });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain(`-c 'model_reasoning_effort="high"'`);
  });

  it("buildPrintCommand omits model reasoning effort config when not specified", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("model_reasoning_effort");
  });

  it("supports all codex effort levels", () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const provider = codex("gpt-5.4-mini", { effort });
      expect(provider.buildPrintCommand(opts("test")).command).toContain(
        `model_reasoning_effort="${effort}"`,
      );
    }
  });
  it("parseStreamLine extracts text and result from item.completed agent_message", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Hello world" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
      { type: "result", result: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts tool call from item.started command_execution", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "npm test" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine skips turn.completed events", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({ type: "turn.completed" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine handles item.completed with missing text", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine does not extract from item.content (array form), only item.text", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        content: [{ type: "text", text: "from content array" }],
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.started with missing command", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "command_execution" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.completed with non-agent_message type", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.completed",
      item: { type: "other_type", content: "foo" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles item.started with non-command_execution type", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "item.started",
      item: { type: "other_type", command: "foo" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = codex("model-a");
    const provider2 = codex("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  // --- error event parsing tests ---

  it("parseStreamLine captures error event with nested error object as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      error: { type: "server_error", message: "Internal server error" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Internal server error" },
    ]);
  });

  it("parseStreamLine captures error event with string error as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      error: "Authentication failed: invalid API key",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Authentication failed: invalid API key" },
    ]);
  });

  it("parseStreamLine captures error event with top-level message as result", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      message: "Rate limit exceeded",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "result", result: "Rate limit exceeded" },
    ]);
  });

  it("parseStreamLine returns empty array for error event with no extractable message", () => {
    const provider = codex("gpt-5.4-mini");
    const line = JSON.stringify({
      type: "error",
      code: "unknown",
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = codex("gpt-5.4-mini", { env: { OPENAI_KEY: "xyz" } });
    expect(provider.env).toEqual({ OPENAI_KEY: "xyz" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = codex("gpt-5.4-mini");
    expect(provider.env).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// opencode factory
// ---------------------------------------------------------------------------

const opencodeJsonLine = (event: unknown): string => JSON.stringify(event);

const createOpenCodeParser = () => {
  const parser = opencode("opencode/big-pickle").createStreamParser?.();
  if (parser === undefined) {
    throw new Error("OpenCode provider did not expose a stream parser");
  }
  return parser;
};

const finishOpenCodeParser = (
  parser: ReturnType<typeof createOpenCodeParser>,
  exitCode = 0,
) => {
  const events = parser.finish?.({ exitCode });
  if (events === undefined) {
    throw new Error("OpenCode parser did not expose finish()");
  }
  return events;
};

describe("opencode factory", () => {
  it("returns a provider with name 'opencode'", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.name).toBe("opencode");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand requests JSON output, thinking, model, and prompt", () => {
    const provider = opencode("opencode/big-pickle");
    const { command, stdin } = provider.buildPrintCommand(opts("do something"));
    expect(command).toBe(
      "opencode run --format json --thinking --dangerously-skip-permissions --model 'opencode/big-pickle' -- 'do something'",
    );
    expect(stdin).toBeUndefined();
  });

  it("buildPrintCommand omits --dangerously-skip-permissions when false", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand({
      prompt: "do something",
      dangerouslySkipPermissions: false,
    });
    expect(command).toBe(
      "opencode run --format json --thinking --model 'opencode/big-pickle' -- 'do something'",
    );
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("it's a test"));
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'opencode/big-pickle'");
  });

  it("buildPrintCommand includes free-form variant when specified", () => {
    const provider = opencode("opencode/big-pickle", {
      variant: "provider/reasoning=max",
    });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--variant 'provider/reasoning=max'");
  });

  it("buildPrintCommand omits variant when not specified", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).not.toContain("--variant");
  });

  it("buildPrintCommand shell-escapes free-form variant values", () => {
    const provider = opencode("model's", {
      variant: "provider/high's max",
    });
    const { command } = provider.buildPrintCommand(opts("do something"));
    expect(command).toContain("--model 'model'\\''s'");
    expect(command).toContain("--variant 'provider/high'\\''s max'");
  });

  it("buildPrintCommand keeps -- before option-looking prompts", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand(
      opts("--share --attach=thing"),
    );
    expect(command).toContain("-- '--share --attach=thing'");
  });

  it("buildInteractiveArgs stays unchanged for the OpenCode TUI", () => {
    const provider = opencode("opencode/big-pickle", {
      variant: "provider/reasoning=max",
    });
    expect(provider.buildInteractiveArgs!(opts("do something"))).toEqual([
      "opencode",
      "--model",
      "opencode/big-pickle",
      "-p",
      "do something",
    ]);
  });

  it("parseStreamLine delegates JSON text parsing without raw passthrough", () => {
    const provider = opencode("opencode/big-pickle");
    expect(
      provider.parseStreamLine(
        opencodeJsonLine({ type: "text", part: { text: "hi" } }),
      ),
    ).toEqual([{ type: "text", text: "hi" }]);
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("createStreamParser streams text and returns final assistant text on finish", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({ type: "text", part: { text: "Hello" } }),
      ),
    ).toEqual([{ type: "text", text: "Hello" }]);
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({ type: "text", part: { text: " world" } }),
      ),
    ).toEqual([{ type: "text", text: " world" }]);
    expect(finishOpenCodeParser(parser)).toEqual([
      { type: "result", result: "Hello world" },
    ]);
  });

  it("createStreamParser streams reasoning as display-only thinking", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({ type: "reasoning", part: { text: "checking" } }),
      ),
    ).toEqual([{ type: "text", text: "[thinking] checking" }]);
    expect(finishOpenCodeParser(parser)).toEqual([
      { type: "result", result: "" },
    ]);
  });

  it("createStreamParser maps allowlisted lowercase tool_use events", () => {
    const cases = [
      ["bash", "Bash", { command: "npm test" }, "npm test"],
      [
        "websearch",
        "WebSearch",
        { query: "sandcastle docs" },
        "sandcastle docs",
      ],
      [
        "webfetch",
        "WebFetch",
        { url: "https://example.com" },
        "https://example.com",
      ],
      ["task", "Agent", { description: "delegate work" }, "delegate work"],
    ] as const;

    for (const [tool, name, input, args] of cases) {
      const parser = createOpenCodeParser();
      expect(
        parser.parseStreamLine(
          opencodeJsonLine({ type: "tool_use", part: { tool, input } }),
        ),
      ).toEqual([{ type: "tool_call", name, args }]);
    }
  });

  it("createStreamParser falls back to state title without leaking output fields", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: {
            tool: "bash",
            state: {
              title: "Run tests",
              output: "<promise>COMPLETE</promise>",
              metadata: { output: "<plan>leak</plan>" },
            },
          },
        }),
      ),
    ).toEqual([{ type: "tool_call", name: "Bash", args: "Run tests" }]);
  });

  it("createStreamParser prefers known tool input fields over state title", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: {
            tool: "bash",
            input: { command: "npm test" },
            state: { title: "fallback title", output: "do not show" },
          },
        }),
      ),
    ).toEqual([{ type: "tool_call", name: "Bash", args: "npm test" }]);
  });

  it("createStreamParser prefers part input over state input for tool summaries", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: {
            tool: "bash",
            input: { command: "fallback command" },
            state: {
              input: { command: "state command" },
              title: "fallback title",
            },
          },
        }),
      ),
    ).toEqual([{ type: "tool_call", name: "Bash", args: "fallback command" }]);
  });

  it("createStreamParser falls back to state input when part input is missing", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: {
            tool: "bash",
            state: {
              input: { command: "state command" },
              title: "fallback title",
            },
          },
        }),
      ),
    ).toEqual([{ type: "tool_call", name: "Bash", args: "state command" }]);
  });

  it("createStreamParser preserves tool display args without truncation", () => {
    const parser = createOpenCodeParser();
    const longCommand = `npm\n${"test ".repeat(60)}`;
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: { tool: "bash", input: { command: longCommand } },
        }),
      ),
    ).toEqual([{ type: "tool_call", name: "Bash", args: longCommand }]);
  });

  it("createStreamParser ignores uppercase, unknown, and output-only tools", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: { tool: "Bash", input: { command: "npm test" } },
        }),
      ),
    ).toEqual([]);
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: { tool: "read", input: { path: "src/index.ts" } },
        }),
      ),
    ).toEqual([]);
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "tool_use",
          part: {
            tool: "bash",
            state: { output: "secret", metadata: { output: "secret" } },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("createStreamParser resets current assistant step and stops on final step_finish", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({ type: "text", part: { text: "draft" } }),
      ),
    ).toEqual([{ type: "text", text: "draft" }]);
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "step_finish",
          part: { reason: "tool-calls" },
        }),
      ),
    ).toEqual([]);
    expect(
      parser.parseStreamLine(opencodeJsonLine({ type: "step_start" })),
    ).toEqual([]);
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({ type: "text", part: { text: "final" } }),
      ),
    ).toEqual([{ type: "text", text: "final" }]);
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({ type: "step_finish", part: { reason: "stop" } }),
      ),
    ).toEqual([{ type: "result", result: "final" }]);
    expect(finishOpenCodeParser(parser)).toEqual([]);
  });

  it("createStreamParser does not use tool-call steps as clean-exit results", () => {
    const parser = createOpenCodeParser();
    parser.parseStreamLine(
      opencodeJsonLine({ type: "text", part: { text: "draft" } }),
    );
    parser.parseStreamLine(
      opencodeJsonLine({
        type: "step_finish",
        part: { reason: "tool-calls" },
      }),
    );
    expect(finishOpenCodeParser(parser)).toEqual([
      { type: "result", result: "" },
    ]);
  });

  it("createStreamParser extracts nested error.data.message as an error", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "error",
          error: { data: { message: "OpenCode failed" } },
        }),
      ),
    ).toEqual([{ type: "error", error: "OpenCode failed" }]);
  });

  it("createStreamParser ignores malformed and non-JSON lines directly", () => {
    const parser = createOpenCodeParser();
    expect(parser.parseStreamLine("{bad json")).toEqual([]);
    expect(parser.parseStreamLine("not json")).toEqual([]);
    expect(parser.parseStreamLine("")).toEqual([]);
    expect(
      parser.parseStreamLine(opencodeJsonLine({ type: "unknown_event" })),
    ).toEqual([]);
  });

  it("createStreamParser ignores unknown step_finish reasons", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(
        opencodeJsonLine({
          type: "step_finish",
          part: { reason: "cancelled" },
        }),
      ),
    ).toEqual([]);
  });

  it("createStreamParser emits an empty structured result for unknown JSON events", () => {
    const parser = createOpenCodeParser();
    expect(
      parser.parseStreamLine(opencodeJsonLine({ type: "unknown_event" })),
    ).toEqual([]);
    expect(finishOpenCodeParser(parser)).toEqual([
      { type: "result", result: "" },
    ]);
  });

  it("createStreamParser does not emit a finish result for unstructured output", () => {
    const parser = createOpenCodeParser();
    parser.parseStreamLine("not json");
    parser.parseStreamLine("{bad json");
    parser.parseStreamLine("");
    expect(finishOpenCodeParser(parser)).toEqual([]);
  });

  it("createStreamParser treats a later step_start as authoritative on finish", () => {
    const parser = createOpenCodeParser();
    parser.parseStreamLine(
      opencodeJsonLine({ type: "text", part: { text: "old answer" } }),
    );
    parser.parseStreamLine(opencodeJsonLine({ type: "step_start" }));
    expect(finishOpenCodeParser(parser)).toEqual([
      { type: "result", result: "" },
    ]);
  });

  it("createStreamParser emits at most one final result", () => {
    const parser = createOpenCodeParser();
    parser.parseStreamLine(
      opencodeJsonLine({ type: "text", part: { text: "done" } }),
    );
    expect(finishOpenCodeParser(parser)).toEqual([
      { type: "result", result: "done" },
    ]);
    expect(finishOpenCodeParser(parser)).toEqual([]);
  });

  it("createStreamParser does not synthesize clean-exit fallback on nonzero exit", () => {
    const parser = createOpenCodeParser();
    parser.parseStreamLine(
      opencodeJsonLine({ type: "text", part: { text: "partial" } }),
    );
    expect(finishOpenCodeParser(parser, 1)).toEqual([]);
  });

  it("createStreamParser keeps parser state scoped to each invocation", () => {
    const provider = opencode("opencode/big-pickle");
    const firstParser = provider.createStreamParser!();
    const secondParser = provider.createStreamParser!();

    firstParser.parseStreamLine(
      opencodeJsonLine({ type: "text", part: { text: "first" } }),
    );
    secondParser.parseStreamLine(
      opencodeJsonLine({ type: "text", part: { text: "second" } }),
    );

    expect(finishOpenCodeParser(firstParser)).toEqual([
      { type: "result", result: "first" },
    ]);
    expect(finishOpenCodeParser(secondParser)).toEqual([
      { type: "result", result: "second" },
    ]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = opencode("model-a");
    const provider2 = opencode("model-b");
    expect(provider1.buildPrintCommand(opts("test")).command).toContain(
      "model-a",
    );
    expect(provider2.buildPrintCommand(opts("test")).command).toContain(
      "model-b",
    );
    expect(provider1.buildPrintCommand(opts("test")).command).not.toContain(
      "model-b",
    );
  });

  it("accepts an env option and exposes it on the provider", () => {
    const provider = opencode("opencode/big-pickle", {
      env: { OPENCODE_API_KEY: "sk-test" },
    });
    expect(provider.env).toEqual({ OPENCODE_API_KEY: "sk-test" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = opencode("opencode/big-pickle");
    expect(provider.env).toEqual({});
  });
});

describe("resumeSession on non-Claude providers", () => {
  it("pi ignores resumeSession in buildPrintCommand", () => {
    const provider = pi("claude-sonnet-4-6");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("abc-123");
  });

  it("codex ignores resumeSession in buildPrintCommand", () => {
    const provider = codex("gpt-5.4-mini");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("abc-123");
  });

  it("opencode ignores resumeSession in buildPrintCommand", () => {
    const provider = opencode("opencode/big-pickle");
    const { command } = provider.buildPrintCommand({
      prompt: "test",
      dangerouslySkipPermissions: true,
      resumeSession: "abc-123",
    });
    expect(command).not.toContain("--resume");
    expect(command).not.toContain("abc-123");
  });
});

describe("parseSessionUsage (Claude Code)", () => {
  const provider = claudeCode("claude-opus-4-6");

  it("extracts usage from the last assistant message in a JSONL string", () => {
    const content = [
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 50,
          },
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: 9294,
            cache_read_input_tokens: 8526,
            output_tokens: 458,
          },
        },
      }),
    ].join("\n");

    expect(provider.parseSessionUsage!(content)).toEqual({
      inputTokens: 3,
      cacheCreationInputTokens: 9294,
      cacheReadInputTokens: 8526,
      outputTokens: 458,
    });
  });

  it("returns undefined for empty content", () => {
    expect(provider.parseSessionUsage!("")).toBeUndefined();
  });

  it("returns undefined for content with no assistant messages", () => {
    const content = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "result", result: "done" }),
    ].join("\n");
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("returns undefined when assistant message has no usage block", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "hi" }],
      },
    });
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("returns undefined for malformed JSON lines", () => {
    const content = "not json\n{bad json\n";
    expect(provider.parseSessionUsage!(content)).toBeUndefined();
  });

  it("skips malformed lines and finds valid assistant message", () => {
    const content = [
      "not json",
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
          },
        },
      }),
    ].join("\n");

    expect(provider.parseSessionUsage!(content)).toEqual({
      inputTokens: 10,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
      outputTokens: 40,
    });
  });

  it("is not defined on pi provider", () => {
    expect(pi("model").parseSessionUsage).toBeUndefined();
  });

  it("is not defined on codex provider", () => {
    expect(codex("model").parseSessionUsage).toBeUndefined();
  });

  it("is not defined on opencode provider", () => {
    expect(opencode("model").parseSessionUsage).toBeUndefined();
  });
});

describe("captureSessions flag", () => {
  it("claudeCode defaults captureSessions to true", () => {
    expect(claudeCode("claude-opus-4-6").captureSessions).toBe(true);
  });

  it("claudeCode allows opting out of captureSessions", () => {
    expect(
      claudeCode("claude-opus-4-6", { captureSessions: false }).captureSessions,
    ).toBe(false);
  });

  it("pi has captureSessions false", () => {
    expect(pi("pi-model").captureSessions).toBe(false);
  });

  it("codex has captureSessions false", () => {
    expect(codex("codex-model").captureSessions).toBe(false);
  });

  it("opencode has captureSessions false", () => {
    expect(opencode("opencode-model").captureSessions).toBe(false);
  });
});
