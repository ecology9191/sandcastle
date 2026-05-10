# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. Run `git merge <branch> --no-edit`
2. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
3. After resolving conflicts, run `npm run typecheck` and `npm run test` to verify everything works
4. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

Only close issue IDs listed below. This list is generated from the same merge-eligible task list as the branch list above; skipped, failed, missing-context, incomplete, or unmerged branches are not close candidates.

For each branch that was merged, close its issue by replacing `<ID>` in the following command:

`{{CLOSE_TASK_COMMAND}}`

Merge-eligible issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
