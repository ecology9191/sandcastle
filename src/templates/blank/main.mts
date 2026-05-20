import { readFileSync } from "node:fs";
import * as sandcastle from "@ecology91/sandcastle";
import { docker } from "@ecology91/sandcastle/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.mts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.mts"

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

await sandcastle.run({
  agent: createCodingAgent(),
  sandbox: docker(),
  promptFile: "./.sandcastle/prompt.md",
});
