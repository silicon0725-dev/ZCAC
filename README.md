# ZCAC — ZCode Agent Cluster

**多 Agent 编排层,构建在 ZCode Agent Runtime 之上。**

ZCode 负责单个 Agent 的执行;ZCAC 负责让哪些 Agent 在什么时候、以什么依赖关系,共同完成什么任务。

```
/cluster "Add a REST endpoint with tests"
  ↓
Planner → Coder × N (parallel, git worktree isolation) → Tester → Reviewer
  ↓ (FAIL → auto-inject Fix → Re-review, max 3 rounds)
Run completed (all changes merged back)
```

## Status

| Milestone | Status |
|---|---|
| v0.1 core (executor / task graph / scheduler / pool / lease / review / worktree / plugin) | ✅ |
| v0.2 (pipeline mode / worktree+pipeline / supervisor decisions / rate-limit backoff) | ✅ |
| Real-repo stress test (6 tasks) | ✅ 5/6 |
| Kill recovery + memory stability | ✅ |
| 75 unit tests | ✅ 75/75 |

## Quick Start

### Prerequisites

- [ZCode](https://github.com/zai-org/ZCode) v3.14.3+ (desktop or CLI)
- Node.js ≥24
- GLM model access (BigModel Coding Plan)

### Install

```bash
# 1. Clone ZCode (the upstream runtime ZCAC depends on)
git clone https://github.com/zai-org/ZCode zcode-repo
cd zcode-repo
pnpm install --filter @zcode/cli...

# 2. Copy ZCAC into the monorepo
git clone https://github.com/silicon0725-dev/ZCAC zcac-source
cp -r zcac-source/packages/zcac packages/

# 3. Install ZCAC dependencies and build
pnpm install --filter zcac
pnpm --filter zcac build    # compiles TS + bundles the MCP orchestrator

# 4. Register as ZCode inline plugin
node zcac-source/scripts/install-inline.js "$(pwd)/packages/zcac/plugin"

# 5. Restart ZCode and try:
#    /cluster hello world test
```

### Usage

```
/cluster <task>        # Run a task (auto-selects single/pipeline mode)
/cluster-status        # Check latest run status
/cluster-stop          # Stop a running cluster
```

MCP tools (visible to the model as `mcp__zcac__*`):

| Tool | Purpose |
|---|---|
| `cluster_create` | Create a run; `mode=pipeline` decomposes first |
| `cluster_status` | Run status + task counts + event tail |
| `cluster_stop` | Abort in-flight agents |
| `task_list` | Per-task status/attempts/summaries |
| `artifact_list` | Artifacts with checksums |
| `events` | Full journal, cursor-based replay |

### Configuration

In ZCode plugin settings (`zcode-agent-cluster`):

| Option | Default | Description |
|---|---|---|
| `zcacModel` | `bigmodel-api/GLM-5.3-Flash@low` | Worker model |
| `zcacIsolation` | `shared` | `shared` or `worktree` (isolated git worktrees, auto-merge) |
| `zcacConcurrency` | `2` | Max parallel tasks |

## Architecture

```
ZCode (desktop/CLI)
  │  /cluster → MCP tools
  ▼
ZCAC Orchestrator (stdio MCP server, persistent SQLite)
  ├── Task Graph        (runtime-mutable DAG)
  ├── Scheduler         (dependency-aware + role quotas + rate-limit backoff)
  ├── Agent Pool        (slots + leases + heartbeats)
  ├── Review Loop       (FAIL → Fix → Re-review, max 3 rounds)
  ├── Pipeline          (planner decomposition → dynamic task injection)
  ├── Supervisor        (conflict redo / re-plan, budgeted)
  ├── Worktree Manager  (git worktree isolation, merge-on-success)
  └── Event Journal     (SQLite, journal-first)
  ▼
ZCode Agent Runtime (one per worker)
  ▼
GLM-5.3 / GLM-5.3-Flash
```

Key design decisions:

| Decision | Rationale |
|---|---|
| Worker = standalone `createZCodeApp` composition | SubagentPort not publicly exported; equivalent to dwf actor pattern |
| Merge-on-success for worktrees | Downstream tasks always see merged state in main workspace |
| Journal-first (SQLite before live emit) | No ghost events after crash |
| Exponential backoff on rate-limit signals | Measured 3-8× wall-clock improvement |
| Completed tasks immutable | Crash recovery never re-runs confirmed work |

## Development

```bash
# Inside zcode-repo with packages/zcac present:
pnpm --filter zcac test                    # 75 unit tests
pnpm --filter zcac build                   # compile + bundle orchestrator

# E2E tests (real GLM, costs tokens):
node packages/zcac/dist/e2e.cjs            # single task
node packages/zcac/dist/e2e-parallel.cjs   # dual coder parallel
node packages/zcac/dist/e2e-review.cjs     # review→fix→re-review loop
node packages/zcac/dist/e2e-worktree.cjs   # worktree isolation + conflict
node packages/zcac/dist/e2e-pipeline.cjs   # planner pipeline
node packages/zcac/dist/stress.cjs         # 6-task stress test
```

## Documentation

- [Design document](docs/design.md) — original architecture vision
- [Implementation spec](docs/implementation-spec.md) — v0.1 specification
- [Architecture reconnaissance](docs/architecture-report.md) — ZCode source analysis
- [Phase records](docs/phases/) — 12 implementation phases with findings

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| run `failed`, `rate_limit` | Model quota exhausted | Wait; lower concurrency |
| run `failed`, `merge_conflict` | Parallel write to same file | Supervisor auto-redoes; check `git worktree list` |
| run `failed`, `plan_unparseable` | Planner output malformed | Supervisor re-plans; if persistent, simplify task |
| run `failed`, `review_max_rounds` | 3 review rounds failed | Check findings in `events` |
| Dirty files in main workspace | Agent path drift (rare) | `git status`; use worktree mode |
| Stuck in `running` after crash | Lease not expired yet | Wait 120s or restart ZCode |

## Known Limitations (v0.2)

- Single-process orchestrator (ProtocolExecutor planned for v0.3)
- Run status stays `failed` when Supervisor recovery succeeds (terminal immutability)
- No web UI; observation via `cluster_status` / `events` MCP tools
- Plugin registered as inline directory (dev mode); proper distribution needs packaging

## License

Apache-2.0
