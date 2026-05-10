import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

export const TERMINAL_OUTPUT_ENV_KEY = "SANDCASTLE_TERMINAL_OUTPUT";

export type TerminalOutputMode = "off" | "verbose";

export const resolveTerminalOutputMode = (
  env: Record<string, string>,
): TerminalOutputMode => {
  const value = env[TERMINAL_OUTPUT_ENV_KEY];
  if (value === undefined) return "off";
  if (value === "off" || value === "verbose") return value;
  throw new Error(
    `Invalid ${TERMINAL_OUTPUT_ENV_KEY} value "${value}". Expected "off" or "verbose".`,
  );
};

export const stripHostSandcastleEnv = (
  env: Record<string, string>,
): Record<string, string> => {
  const { [TERMINAL_OUTPUT_ENV_KEY]: _terminalOutput, ...sandboxEnv } = env;
  return sandboxEnv;
};

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return {};
    const vars: Record<string, string> = {};
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
      vars[key] = value;
    }
    return vars;
  });

/**
 * Resolve all env vars from .env files with process.env fallback.
 *
 * Precedence: .sandcastle/.env > process.env
 * Only keys declared in .sandcastle/.env are resolved from process.env.
 * Repo root .env is not part of the resolution chain.
 */
export const resolveEnv = (
  repoDir: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const sandcastleEnv = yield* parseEnvFile(
      join(repoDir, ".sandcastle", ".env"),
    );

    const result: Record<string, string> = {};
    for (const key of Object.keys(sandcastleEnv)) {
      const value = sandcastleEnv[key] || process.env[key];
      if (value) {
        result[key] = value;
      }
    }

    return result;
  });
