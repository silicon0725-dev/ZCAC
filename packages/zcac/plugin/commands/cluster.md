---
description: Run a coding task through the ZCAC multi-agent cluster
argument-hint: <task description> [pipeline]
---
Run the user's task through the ZCAC cluster using the `mcp__zcac__*` MCP tools:

**Model selection** (only if the user hasn't specified or this is a new setup):
Before creating the run, call `mcp__zcac__list_models` to see available models.
If the user hasn't chosen models yet, offer a brief selection (e.g. "Fast (Flash) or Smart (Pro)?").
Use `mcp__zcac__configure` with `action: "set"` to assign role models if the user
wants different models for different roles (e.g. planner/coder/tester).

**Running the task:**
1. Choose the mode:
   - `pipeline` (default for non-trivial tasks): planner decomposes → implement/test → review.
   - `single`: one coder task (trivial changes only).
2. Call `mcp__zcac__cluster_create` with the full task text and chosen `mode`.
3. Poll `mcp__zcac__cluster_status` until `completed` or `failed`.
4. When finished, call `mcp__zcac__task_list` and summarize results.
   Also call `mcp__zcac__get_messages` to check inter-agent communications.

**Messaging** (agent collaboration):
- `send_message` / `get_messages` / `reply_message` / `get_thread` — structured agent communication

**Configuration:**
- `list_models` — enumerate all available models with reasoning levels
- `configure` — get/set role models, default model, isolation, concurrency at runtime

Do not re-implement the task yourself — the cluster's workers do the work.

User task: $ARGUMENTS

