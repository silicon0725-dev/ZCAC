/**
 * ZCAC Phase 15 — 实时 Web Dashboard(HTTP + SSE, ZCode 原生风格)。
 *
 * 端点:
 *   GET /              → HTML 仪表盘
 *   GET /api/snapshot  → JSON 全量状态(含任务详情/prompt/output/messages)
 *   GET /api/events    → SSE 实时事件流
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ClusterEvent } from "../domain/event/cluster-event.js";
import type { Task } from "../domain/task/task.js";
import type { AgentMessage } from "../domain/message/agent-message.js";
import type { Run } from "../domain/run/run.js";

export interface DashboardServerDeps {
  getRun: () => Run | undefined;
  getTasks: () => Task[];
  getMessages: (runId: string) => AgentMessage[];
  getEvents: (runId: string) => ClusterEvent[];
  port: number;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildSnapshot(deps: DashboardServerDeps) {
  const run = deps.getRun();
  const tasks = deps.getTasks();
  const runId = run?.id ?? "";
  const messages = runId ? deps.getMessages(runId) : [];
  const now = Date.now();
  return {
    run: run ? { id: run.id, status: run.status, createdAt: run.createdAt } : null,
    tasks: tasks.map((t) => ({
      id: t.id, kind: t.kind, role: t.input.role ?? "coder", status: t.status,
      attempt: t.attempt, priority: t.priority,
      startedAt: t.startedAt, completedAt: t.completedAt,
      prompt: t.input.prompt?.slice(0, 500),
      outputSummary: t.output?.summary ?? t.output?.response?.slice(0, 300),
      outputResponse: t.output?.response?.slice(0, 1000),
      findings: t.output?.findings,
      errorCode: t.error?.code, errorMessage: t.error?.message,
      dependencies: t.dependencies,
      roleModel: t.input.model,
    })),
    messages: messages.slice(-30).map((m) => ({
      id: m.id, threadId: m.threadId, from: m.fromAgent, to: m.toAgent,
      type: m.type, content: m.content.slice(0, 300), taskId: m.taskId,
    })),
    events: deps.getEvents(runId).slice(-50).map((e) => ({
      sequence: e.sequence, type: e.type, taskId: e.taskId,
      payload: e.payload, timestamp: e.timestamp,
    })),
  };
}

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>ZCAC — Cluster</title>
<style>
:root {
  --bg: #1a1b26; --bg-dark: #16161e; --bg-panel: #1f2335; --bg-hover: #24283b;
  --border: #2f334d; --border-light: #3b4261;
  --fg: #c0caf5; --fg-dim: #565f89; --fg-bright: #a9b1d6;
  --blue: #7aa2f7; --green: #9ece6a; --red: #f7768e; --yellow: #e0af68;
  --purple: #bb9af7; --cyan: #7dcfff; --orange: #ff9e64;
  --radius: 6px;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:var(--bg-dark); color:var(--fg); font-size:13px; overflow:hidden; height:100vh; display:flex; flex-direction:column; }

.topbar { display:flex; align-items:center; justify-content:space-between; padding:8px 16px; background:var(--bg-panel); border-bottom:1px solid var(--border); flex-shrink:0; }
.topbar h1 { font-size:14px; font-weight:600; color:var(--fg-bright); }
.topbar .right { display:flex; gap:12px; align-items:center; font-size:12px; color:var(--fg-dim); }
.badge { padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; }
.badge.running { background:#1a2e1a; color:var(--green); }
.badge.completed { background:#1a2e1a; color:var(--green); }
.badge.failed { background:#2d1a1e; color:var(--red); }
.badge.created { background:#1a2135; color:var(--blue); }

.progress-track { height:3px; background:var(--border); flex-shrink:0; }
.progress-bar { height:100%; background:var(--green); transition:width .6s ease; }

.main { display:flex; flex:1; overflow:hidden; }

/* Sidebar */
.sidebar { width:220px; background:var(--bg-dark); border-right:1px solid var(--border); overflow-y:auto; flex-shrink:0; }
.sidebar-section { padding:8px 0; }
.sidebar-title { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:var(--fg-dim); padding:4px 12px; }
.agent-item { display:flex; align-items:center; gap:8px; padding:6px 12px; cursor:pointer; }
.agent-item:hover { background:var(--bg-hover); }
.agent-item.selected { background:var(--bg-panel); border-left:2px solid var(--blue); }
.agent-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.agent-dot.running { background:var(--yellow); animation:pulse 1.5s infinite; }
.agent-dot.succeeded { background:var(--green); }
.agent-dot.failed { background:var(--red); }
.agent-dot.blocked { background:var(--fg-dim); }
.agent-dot.pending { background:var(--fg-dim); opacity:.5; }
@keyframes pulse { 50% { opacity:.4; } }
.agent-name { flex:1; font-size:12px; }
.agent-time { font-size:11px; color:var(--fg-dim); }

/* Main content */
.content { flex:1; overflow-y:auto; padding:16px; }
.task-card { background:var(--bg-panel); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:8px; overflow:hidden; }
.task-header { display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; }
.task-header:hover { background:var(--bg-hover); }
.task-icon { font-size:16px; flex-shrink:0; }
.task-role { font-weight:600; font-size:13px; min-width:100px; }
.task-kind { color:var(--fg-dim); font-size:12px; }
.task-status { margin-left:auto; font-size:11px; padding:2px 8px; border-radius:10px; }
.task-status.succeeded { background:#1a2e1a; color:var(--green); }
.task-status.running { background:#2d2a1e; color:var(--yellow); }
.task-status.failed { background:#2d1a1e; color:var(--red); }
.task-status.blocked { background:#1a2135; color:var(--fg-dim); }
.task-duration { font-size:11px; color:var(--fg-dim); min-width:40px; text-align:right; }
.task-details { padding:12px 14px; border-top:1px solid var(--border); background:var(--bg-dark); display:none; }
.task-details.open { display:block; }
.detail-row { margin-bottom:8px; }
.detail-label { font-size:11px; color:var(--fg-dim); text-transform:uppercase; margin-bottom:2px; }
.detail-value { font-size:12px; color:var(--fg-bright); white-space:pre-wrap; word-break:break-word; }
.detail-value code { background:var(--bg); padding:2px 4px; border-radius:3px; font-size:11px; }

/* Event stream */
.event-section { border-top:1px solid var(--border); background:var(--bg-dark); height:200px; overflow-y:auto; flex-shrink:0; padding:8px 12px; }
.event-line { display:flex; gap:8px; padding:2px 0; font-size:12px; font-family:monospace; }
.event-seq { color:var(--fg-dim); min-width:36px; }
.event-type { min-width:160px; }
.event-icon { margin-right:4px; }

/* Messages */
.msg-item { padding:4px 12px; font-size:12px; border-left:2px solid var(--blue); margin:4px 0; background:var(--bg-panel); }
.msg-from { font-weight:600; color:var(--cyan); }
.msg-to { color:var(--fg-dim); }

.empty { display:flex; align-items:center; justify-content:center; height:100%; color:var(--fg-dim); font-size:14px; }
</style>
</head>
<body>

<div class="topbar">
  <h1>📊 ZCAC Cluster</h1>
  <div class="right">
    <span id="elapsed">—</span>
    <span class="badge" id="runStatus">—</span>
  </div>
</div>
<div class="progress-track"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>

<div class="main">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-section">
      <div class="sidebar-title">Agents</div>
      <div id="agentList"><div style="padding:12px;color:var(--fg-dim);font-size:12px">No active run</div></div>
    </div>
  </div>
  <div class="content" id="taskList">
    <div class="empty">Start a run with /cluster to see activity</div>
  </div>
</div>

<div class="event-section" id="eventSection">
  <div class="sidebar-title">Event Stream</div>
  <div id="eventLines"></div>
</div>

<script>
let cursor = 0;
const taskDetailOpen = new Set();

function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

async function fetchAndRender() {
  try {
    const res = await fetch('/api/snapshot');
    const data = await res.json();
    render(data);
  } catch(e) { console.error('fetch failed', e); }
}

function render(data) {
  if (!data.run) { document.getElementById('taskList').innerHTML = '<div class="empty">No active run</div>'; return; }

  // Status bar
  const tasks = data.tasks || [];
  const ok = tasks.filter(t => t.status === 'succeeded').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const progress = tasks.length > 0 ? Math.round(ok / tasks.length * 100) : 0;

  const statusEl = document.getElementById('runStatus');
  statusEl.textContent = data.run.status;
  statusEl.className = 'badge ' + data.run.status;

  const firstStart = Math.min(...tasks.map(t => t.startedAt || Date.now()));
  const elapsed = Math.round((Date.now() - firstStart) / 1000);
  document.getElementById('elapsed').textContent =
    (elapsed >= 60 ? Math.floor(elapsed/60) + 'm ' : '') + (elapsed % 60) + 's';

  document.getElementById('progressBar').style.width = progress + '%';

  // Task cards (clickable)
  const taskEl = document.getElementById('taskList');
  const icons = { pending:'⏳', ready:'🟡', running:'⚙️', blocked:'🔒', succeeded:'✅', failed:'❌', retry_wait:'🔄' };
  taskEl.innerHTML = tasks.map(t => {
    const icon = icons[t.status] || '?';
    const isOpen = taskDetailOpen.has(t.id);
    const dur = t.startedAt ? (t.completedAt ? Math.round((t.completedAt - t.startedAt)/1000)+'s' : Math.round((Date.now()-t.startedAt)/1000)+'s…') : '—';
    const attempt = t.attempt > 1 ? ' <span style="color:var(--yellow)">r'+t.attempt+'</span>' : '';
    const roleModel = t.roleModel ? ' <span style="color:var(--fg-dim);font-size:11px">'+esc(t.roleModel)+'</span>' : '';
    let details = '';
    if (isOpen) {
      details = '<div class="task-details">'
        + (t.prompt ? '<div class="detail-row"><div class="detail-label">Prompt</div><div class="detail-value">' + esc(t.prompt).slice(0,300) + '</div></div>' : '')
        + (t.outputSummary ? '<div class="detail-row"><div class="detail-label">Output</div><div class="detail-value">' + esc(t.outputSummary) + '</div></div>' : '')
        + (t.outputResponse ? '<div class="detail-row"><div class="detail-label">Response</div><div class="detail-value">' + esc(t.outputResponse).slice(0,500) + '</div></div>' : '')
        + (t.errorMessage ? '<div class="detail-row"><div class="detail-label" style="color:var(--red)">Error</div><div class="detail-value" style="color:var(--red)">' + esc(t.errorMessage) + '</div></div>' : '')
        + (t.findings ? '<div class="detail-row"><div class="detail-label">Findings</div><div class="detail-value">' + esc(JSON.stringify(t.findings)).slice(0,300) + '</div></div>' : '')
        + '</div>';
    }
    return '<div class="task-card">'
      + '<div class="task-header" onclick="toggleDetail(\\''+t.id+'\\')">'
      + '<span class="task-icon">' + icon + '</span>'
      + '<span class="task-role">' + esc(t.role) + '</span>'
      + '<span class="task-kind">' + esc(t.kind) + attempt + roleModel + '</span>'
      + '<span class="task-status ' + t.status + '">' + t.status + '</span>'
      + '<span class="task-duration">' + dur + '</span>'
      + '</div>' + details + '</div>';
  }).join('');

  // Sidebar agents
  const byRole = {};
  tasks.forEach(t => {
    const role = t.role;
    if (!byRole[role]) byRole[role] = { status: t.status, count: 0, kind: t.kind };
    byRole[role].count++;
    if (t.status === 'running') byRole[role].status = 'running';
  });
  const roleIcons = { coder:'📝', 'frontend-coder':'🎨', 'backend-coder':'⚙️', explorer:'🔍', planner:'📋',
    tester:'🧪', reviewer:'🔍', 'ux-designer':'📐', 'ui-designer':'🎨', 'market-researcher':'📊', 'integration-tester':'🔗' };
  document.getElementById('agentList').innerHTML = Object.entries(byRole).map(([role, info]) => {
    const dotClass = info.status === 'running' ? 'running' : info.status === 'succeeded' ? 'succeeded' : info.status === 'failed' ? 'failed' : 'pending';
    const icon = roleIcons[role] || '🤖';
    return '<div class="agent-item"><span class="agent-dot ' + dotClass + '"></span>'
      + '<span>' + icon + '</span><span class="agent-name">' + esc(role) + ' ×' + info.count + '</span></div>';
  }).join('');

  // Event stream
  const eventEl = document.getElementById('eventLines');
  const evIcons = { RUN_CREATED:'🚀',RUN_STARTED:'▶️',RUN_COMPLETED:'✅',RUN_FAILED:'❌',
    TASK_CREATED:'📋',TASK_READY:'🟡',TASK_STARTED:'⚙️',TASK_SUCCEEDED:'✅',TASK_FAILED:'❌',
    TASK_RETRY:'🔄',TASK_BLOCKED:'🔒',AGENT_ASSIGNED:'👤',AGENT_RELEASED:'👋',
    ARTIFACT_CREATED:'📦',WORKTREE_CREATED:'🌲',WORKTREE_REMOVED:'🗑️',
    MERGE_STARTED:'🔀',MERGE_COMPLETED:'🔀',MERGE_CONFLICT:'⚠️',SUPERVISOR_DECISION:'🧠' };
  const newEvents = (data.events || []).filter(e => e.sequence > cursor);
  if (newEvents.length > 0) {
    cursor = newEvents[newEvents.length-1].sequence;
    newEvents.forEach(e => {
      const icon = evIcons[e.type] || '•';
      const line = document.createElement('div');
      line.className = 'event-line';
      line.innerHTML = '<span class="event-seq">#'+e.sequence+'</span>'
        + '<span><span class="event-icon">'+icon+'</span> '+esc(e.type)+'</span>';
      eventEl.insertBefore(line, eventEl.firstChild);
    });
    // Keep max 200 lines
    while (eventEl.children.length > 200) eventEl.removeChild(eventEl.lastChild);
  }

  // Messages
  const msgEl = document.getElementById('messages') || createMsgSection();
  if (data.messages && data.messages.length > 0) {
    msgEl.innerHTML = data.messages.map(m =>
      '<div class="msg-item"><span class="msg-from">'+esc(m.from)+'</span> → <span class="msg-to">'+esc(m.to)+'</span>: '+esc(m.content).slice(0,80)+'</div>'
    ).join('');
  }
}

function toggleDetail(taskId) {
  if (taskDetailOpen.has(taskId)) taskDetailOpen.delete(taskId);
  else taskDetailOpen.add(taskId);
  fetchAndRender();
}

// SSE for real-time event push
const evtSource = new EventSource('/api/events');
evtSource.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === 'event' && data.event) {
    // Just trigger a re-render; full state comes from snapshot
    fetchAndRender();
  }
};

// Initial load + periodic refresh
fetchAndRender();
setInterval(fetchAndRender, 3000);
</script>
</body>
</html>`;

export class DashboardServer {
  readonly #deps: DashboardServerDeps;
  readonly #sseClients = new Set<ServerResponse>();
  server: ReturnType<typeof createServer> | undefined;

  constructor(deps: DashboardServerDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (url === "/api/snapshot") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(this.#snapshot()));
        return;
      }
      if (url === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        this.#sseClients.add(res);
        const heartbeat = setInterval(() => {
          try { res.write(": hb\n\n"); } catch { /* client gone */ }
        }, 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          this.#sseClients.delete(res);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.server.listen(this.#deps.port, "127.0.0.1", () => {
      console.error(`[zcac] dashboard: http://127.0.0.1:${this.#deps.port}`);
    });
  }

  broadcastEvent(event: ClusterEvent): void {
    const data = sseData({ type: "event", event: { type: event.type, sequence: event.sequence, taskId: event.taskId } });
    for (const client of this.#sseClients) {
      try { client.write(data); } catch { /* client disconnected */ }
    }
  }

  #snapshot(): Record<string, unknown> {
    return buildSnapshotData(this.#deps);
  }

  stop(): void {
    this.server?.close();
  }
}

// Shared snapshot builder (used by both DashboardServer and MCP tool)
export function buildSnapshotData(deps: DashboardServerDeps): Record<string, unknown> {
  return buildSnapshotFromDeps(deps);
}

function buildSnapshotFromDeps(deps: DashboardServerDeps): Record<string, unknown> {
  const run = deps.getRun();
  const tasks = deps.getTasks();
  const runId = run?.id ?? "";
  const messages = runId ? deps.getMessages(runId) : [];
  const now = Date.now();

  return {
    run: run ? { id: run.id, status: run.status, createdAt: run.createdAt } : null,
    tasks: tasks.map((t: Task) => ({
      id: t.id,
      kind: t.kind,
      role: t.input.role ?? "coder",
      status: t.status,
      attempt: t.attempt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      prompt: t.input.prompt?.slice(0, 500),
      outputSummary: t.output?.summary ?? t.output?.response?.slice(0, 300),
      outputResponse: t.output?.response?.slice(0, 1000),
      findings: t.output?.findings,
      errorCode: t.error?.code,
      errorMessage: t.error?.message,
      dependencies: t.dependencies,
      roleModel: t.input.model,
    })),
    messages: messages.slice(-30).map((m: AgentMessage) => ({
      id: m.id, threadId: m.threadId, from: m.fromAgent, to: m.toAgent,
      type: m.type, content: m.content.slice(0, 300), taskId: m.taskId,
    })),
    events: deps.getEvents(runId).slice(-50).map((e: ClusterEvent) => ({
      sequence: e.sequence, type: e.type, taskId: e.taskId, timestamp: e.timestamp,
    })),
  };
}
