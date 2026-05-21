import { describe, expect, it } from "vitest";
import {
  assertNoGitCredentialMount,
  buildOpenCodeNoPushPermission,
  isGitCredentialEnvKey,
  isGitCredentialMountPath,
  stripGitCredentialEnv,
  withOpenCodeNoPushGuardrails,
} from "./OpenCodeGuardrails.js";

describe("buildOpenCodeNoPushPermission", () => {
  it("defaults to allow with targeted bash deny rules", () => {
    const permission = buildOpenCodeNoPushPermission();

    expect(permission["*"]).toBe("allow");
    expect(permission.bash).toMatchObject({
      "*": "allow",
      "git push*": "deny",
      "git * push*": "deny",
      "gh repo create*": "deny",
      "gh pr create*": "deny",
    });
  });

  it("merges existing bash object rules before no-push denies", () => {
    const permission = buildOpenCodeNoPushPermission(
      JSON.stringify({
        bash: {
          "*": "ask",
          "git push*": "allow",
          "npm *": "allow",
        },
      }),
    );

    expect(permission.bash).toEqual({
      "*": "ask",
      "git push*": "deny",
      "npm *": "allow",
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
    });
  });

  it("converts global allow permissions into granular bash permissions", () => {
    const permission = buildOpenCodeNoPushPermission(JSON.stringify("allow"));

    expect(permission).toMatchObject({
      "*": "allow",
      bash: {
        "*": "allow",
        "git push*": "deny",
      },
    });
  });
});

describe("OpenCode guardrail env", () => {
  it("injects OPENCODE_PERMISSION", () => {
    const env = withOpenCodeNoPushGuardrails({ OPENCODE_API_KEY: "key" });
    const permission = JSON.parse(env.OPENCODE_PERMISSION!);

    expect(env.OPENCODE_API_KEY).toBe("key");
    expect(permission.bash["git push*"]).toBe("deny");
  });

  it("classifies GitHub and git credential env keys", () => {
    expect(isGitCredentialEnvKey("GH_TOKEN")).toBe(true);
    expect(isGitCredentialEnvKey("GITHUB_ACTION_TOKEN")).toBe(true);
    expect(isGitCredentialEnvKey("GIT_ASKPASS")).toBe(true);
    expect(isGitCredentialEnvKey("GIT_CREDENTIAL_HELPER")).toBe(true);
    expect(isGitCredentialEnvKey("GIT_CONFIG_KEY_0")).toBe(true);
    expect(isGitCredentialEnvKey("GCM_CREDENTIAL_STORE")).toBe(true);
    expect(isGitCredentialEnvKey("OPENCODE_API_KEY")).toBe(false);
  });

  it("strips GitHub and git credential env while preserving other values", () => {
    expect(
      stripGitCredentialEnv({
        GH_TOKEN: "gh",
        GITHUB_TOKEN: "github",
        GIT_ASKPASS: "askpass",
        GIT_CONFIG_KEY_0: "credential.helper",
        OPENCODE_API_KEY: "opencode",
      }),
    ).toEqual({
      OPENCODE_API_KEY: "opencode",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});

describe("git credential mount detection", () => {
  it("detects GitHub and git credential paths", () => {
    expect(isGitCredentialMountPath("/home/user/.config/gh")).toBe(true);
    expect(isGitCredentialMountPath("/home/user/.git-credentials")).toBe(true);
    expect(isGitCredentialMountPath("/home/user/.gitconfig")).toBe(true);
    expect(isGitCredentialMountPath("/home/user/.config/git/credentials")).toBe(
      true,
    );
  });

  it("does not treat ~/.ssh as a git credential mount", () => {
    expect(isGitCredentialMountPath("/home/user/.ssh")).toBe(false);
    expect(isGitCredentialMountPath("/home/agent/.ssh")).toBe(false);
  });

  it("rejects mounts that expose credential paths", () => {
    expect(() =>
      assertNoGitCredentialMount({
        hostPath: "/home/user/.config/gh",
        sandboxPath: "/home/agent/.config/gh",
      }),
    ).toThrow(/credential material/);
  });
});
