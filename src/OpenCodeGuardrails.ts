export type OpenCodePermissionAction = "allow" | "ask" | "deny";

type OpenCodePermissionValue =
  | OpenCodePermissionAction
  | Record<
      string,
      OpenCodePermissionAction | Record<string, OpenCodePermissionAction>
    >;

const OPEN_CODE_NO_PUSH_BASH_DENIES: Record<string, "deny"> = {
  "git push*": "deny",
  "git * push*": "deny",
  "git remote add*": "deny",
  "git remote set-url*": "deny",
  "git remote rename*": "deny",
  "gh repo create*": "deny",
  "gh repo fork*": "deny",
  "gh pr create*": "deny",
  "gh release create*": "deny",
  "hub create*": "deny",
  "hub push*": "deny",
  "glab repo create*": "deny",
  "glab push*": "deny",
  "glab mr create*": "deny",
  "git reset --hard*": "deny",
  "git clean -f*": "deny",
  "git clean -fd*": "deny",
  "git branch -D*": "deny",
  "git checkout .": "deny",
  "git restore .": "deny",
};

const GIT_CREDENTIAL_ENV_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "GITHUB_OAUTH_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
]);

const OPEN_CODE_PERMISSION_ENV_KEY = "OPENCODE_PERMISSION";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPermissionAction = (
  value: unknown,
): value is OpenCodePermissionAction =>
  value === "allow" || value === "ask" || value === "deny";

const parseExistingPermission = (
  raw: string | undefined,
): OpenCodePermissionValue => {
  if (raw === undefined || raw.trim() === "") {
    return { "*": "allow", bash: { "*": "allow" } };
  }

  const parsed: unknown = JSON.parse(raw);
  if (isPermissionAction(parsed)) return parsed;
  if (isRecord(parsed)) return parsed as OpenCodePermissionValue;
  throw new Error(
    `${OPEN_CODE_PERMISSION_ENV_KEY} must be a JSON permission action or object`,
  );
};

export const buildOpenCodeNoPushPermission = (
  rawPermission?: string,
): Record<string, unknown> => {
  const existing = parseExistingPermission(rawPermission);

  if (isPermissionAction(existing)) {
    return {
      "*": existing,
      bash: {
        "*": existing,
        ...OPEN_CODE_NO_PUSH_BASH_DENIES,
      },
    };
  }

  const existingBash = existing.bash;
  let bash: Record<string, unknown>;
  if (isPermissionAction(existingBash) || existingBash === undefined) {
    bash = { "*": existingBash ?? "allow" };
  } else if (isRecord(existingBash)) {
    bash = existingBash;
  } else {
    bash = {};
  }

  return {
    "*": "allow",
    ...existing,
    bash: {
      ...bash,
      ...OPEN_CODE_NO_PUSH_BASH_DENIES,
    },
  };
};

export const withOpenCodeNoPushGuardrails = (
  env: Record<string, string>,
): Record<string, string> => ({
  ...env,
  [OPEN_CODE_PERMISSION_ENV_KEY]: JSON.stringify(
    buildOpenCodeNoPushPermission(env[OPEN_CODE_PERMISSION_ENV_KEY]),
  ),
});

export const isGitCredentialEnvKey = (key: string): boolean => {
  if (GIT_CREDENTIAL_ENV_KEYS.has(key)) return true;
  if (/^G(?:H|ITHUB)_.*TOKEN.*/.test(key)) return true;
  if (key.startsWith("GIT_CREDENTIAL_")) return true;
  if (key.startsWith("GCM_")) return true;
  if (key.startsWith("GIT_CONFIG_KEY_")) return true;
  if (key.startsWith("GIT_CONFIG_VALUE_")) return true;
  return false;
};

export const stripGitCredentialEnv = (
  env: Record<string, string>,
): Record<string, string> => {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isGitCredentialEnvKey(key)) {
      stripped[key] = value;
    }
  }
  return {
    ...stripped,
    GIT_TERMINAL_PROMPT: "0",
  };
};

const normalizePathForCredentialCheck = (path: string): string =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const hasCredentialPathSegment = (path: string, segment: string): boolean =>
  path === segment || path.endsWith(segment) || path.includes(`${segment}/`);

export const isGitCredentialMountPath = (path: string): boolean => {
  const normalized = normalizePathForCredentialCheck(path);
  const blockedSegments = [
    "/.config/gh",
    "/.local/share/gh",
    "/.cache/gh",
    "/.git-credentials",
    "/.gitconfig",
    "/.gcm",
    "/.config/git/credentials",
    "/.config/git/credential",
  ];
  return blockedSegments.some((segment) =>
    hasCredentialPathSegment(normalized, segment),
  );
};

export const assertNoGitCredentialMount = (mount: {
  hostPath: string;
  sandboxPath: string;
}): void => {
  if (
    isGitCredentialMountPath(mount.hostPath) ||
    isGitCredentialMountPath(mount.sandboxPath)
  ) {
    throw new Error(
      `Mount exposes GitHub or git credential material: ${mount.hostPath} -> ${mount.sandboxPath}`,
    );
  }
};
