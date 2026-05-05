import * as sandcastle from "@ecology91/sandcastle";
import { podman } from "@ecology91/sandcastle/sandboxes/podman";

const { commits, branch } = await sandcastle.run({
  sandbox: podman(),
  name: "Test",
  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  hooks: {
    sandbox: {
      onSandboxReady: [
        {
          command: "npm install && npm run build",
        },
      ],
    },
  },
});

console.log("Commits:", commits);
console.log("Branch:", branch);
