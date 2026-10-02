---
name: cluster-orchestration
description: Use when the user asks to run, monitor, stop or inspect a ZCAC multi-agent cluster run (/cluster, cluster status, "run this through the cluster"), or when a coding task would clearly benefit from orchestrated multi-agent execution (plan → parallel coders → review loop with automatic fix tasks).
---

# ZCAC Cluster Orchestration

ZCAC runs coding tasks as a multi-agent cluster on top of the ZCode Agent Runtime:
a persistent task graph, a dependency-aware scheduler, an agent pool with per-role
quotas, a review loop that injects fix tasks at runtime, and optional git worktree
isolation per write task.

## When to use

- The user invokes `/cluster <task>`, `/cluster-status` or `/cluster-stop`.
- The user asks to "run this through the cluster" or similar.
- A task is large enough to split (implement + test + review) and the user wants
  orchestrated execution instead of doing it in this session.

## How

All interaction goes through the `mcp__zcac__*` MCP tools:

| Tool | Purpose |
| --- | --- |
| `mcp__zcac__cluster_create` | Create a run for a task; returns immediately, work continues in the background |
| `mcp__zcac__cluster_status` | Run status + task counts + event tail (defaults to latest run) |
| `mcp__zcac__cluster_stop` | Abort in-flight agents, mark run cancelled |
| `mcp__zcac__task_list` | Per-task status/attempts/summaries |
| `mcp__zcac__artifact_list` | Artifacts produced by the run |
| `mcp__zcac__events` | Full journal, supports `afterSequence` cursor for replay |

## Rules

- Create the run with a complete, self-contained task description — the coder
  worker sees only that prompt, not this conversation.
- Do not re-implement the task yourself while a cluster run is active.
- Report progress from `cluster_status`; when the run completes, summarize
  `task_list` and mention artifacts.
- If the run fails, show the failing task error from the events and ask the user
  whether to retry.
