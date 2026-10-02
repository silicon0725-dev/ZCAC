---
description: Run a coding task through the ZCAC multi-agent cluster
argument-hint: <task description> [pipeline]
---
Run the user's task through the ZCAC cluster using the `mcp__zcac__*` MCP tools:

1. Choose the mode:
   - `pipeline` (default for anything bigger than a trivial one-file change): a planner
     decomposes the task, then implement/test tasks run in parallel or sequence, and a
     final review closes the loop.
   - `single`: one coder task, no planning (good for trivial changes).
2. Call `mcp__zcac__cluster_create` with the full task text below as the `task` argument
   and the chosen `mode`.
3. Poll `mcp__zcac__cluster_status` (every call returns the task counts and an event tail)
   until the run status is `completed` or `failed`. Do not poll in a tight loop — check,
   then wait for the next natural turn.
4. When finished, call `mcp__zcac__task_list` and summarize: each task's kind, status,
   attempts and one-line summary. Also call `mcp__zcac__get_messages` to check any
   inter-agent communications (handoffs, questions, findings).
5. If the run failed, show the failing task's error from the events tail and suggest a
   fix or a retry.

You can also use the messaging tools to facilitate agent collaboration:
- `mcp__zcac__send_message` — send a message on behalf of an agent (policy-enforced)
- `mcp__zcac__get_messages` — retrieve messages (filter by agent/thread/task)
- `mcp__zcac__reply_message` — reply to a specific message (auto-joins thread)
- `mcp__zcac__get_thread` — view a full conversation thread

Do not re-implement the task yourself — the cluster's workers do the work. Your job is to
create the run, monitor it, and report the outcome.

User task: $ARGUMENTS

