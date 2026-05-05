import * as sandcastle from "@ecology91/sandcastle";
import { noSandbox } from "@ecology91/sandcastle/sandboxes/no-sandbox";

// /matt-pococks-projects/sandcastle
const { commits, branch } = await sandcastle.interactive({
  branchStrategy: {
    type: "merge-to-head",
  },
  name: "Test",
  agent: sandcastle.claudeCode("claude-sonnet-4-6"),
  prompt: "Add /foobar to the .gitignore, then commit.",
  copyToWorkspace: ["node_modules"],
});

console.log("Commits:", commits);
console.log("Branch:", branch);
