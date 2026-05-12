# READY ISSUES

Here are the claimable agent issues in the repo:

<ready-issues-json>

!`{{PLANNER_LIST_TASKS_COMMAND}}`

</ready-issues-json>

The list above has already been filtered to issues ready for work.

# TASK

{{PLANNER_TASK_INSTRUCTIONS}}

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "bd-a1b2", "title": "Fix auth bug", "branch": "sandcastle/issue-bd-a1b2-fix-auth-bug"}]}
</plan>

If no ready issues are listed, return an empty `issues` array.
