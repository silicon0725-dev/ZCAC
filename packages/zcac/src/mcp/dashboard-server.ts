/**
 * ZCAC Phase 15 — 实时 Web Dashboard(HTTP + SSE)。
 *
 * 编排器启动时开一个 HTTP 端口,浏览器打开即看实时 agent 活动:
 *
 *   ┌───────────────────────────────────────────┐
 *   │ 📊 ZCAC Cluster                    🟢 running │
 *   ├───────────────────────────────────────────┤
 *   │ ✅ coder    implement  32s   done           │
 *   │ ⚙️ tester   test      12s…  running       │
 *   │ 🔒 reviewer review     —     blocked        │
 *   ├───────────────────────────────────────────┤
 *   │ Event Stream                                │
 *   │ ⚙️ TASK_STARTED task_abc (attempt 1)       │
 *   │ 📦 ARTIFACT_CREATED task_abc               │
 *   │ ✅ TASK_SUCCEEDED task_abc 32s              │
 *   └───────────────────────────────────────────┘
 *
 * 端点:
 *   GET /       → HTML 仪表盘(内嵌 JS,自动 SSE 重连)
 *   GET /api/snapshot → JSON 全量状态
 *   GET /api/events   → SSE 实时事件流
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

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="3600">
<title>ZCAC Cluster Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', Consolas, monospace; background: #0d1117; color: #c9d1d9; padding: 16px; }
  h1 { font-size: 18px; margin-bottom: 12px; color: #58a6ff; }
  .status-bar { display: flex; gap: 16px; margin-bottom: 16px; padding: 12px; background: #161b22; border-radius: 8px; border: 1px solid #30363d; }
  .status-item { font-size: 14px; }
  .status-item .label { color: #8b949e; font-size: 12px; }
  .status-item .value { font-size: 18px; font-weight: bold; }
  .green { color: #3fb950; } .red { color: #f85149; } .yellow { color: #d29922; } .blue { color: #58a6ff; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; font-size: 13px; }
  th { color: #8b949e; font-weight: normal; text-transform: uppercase; font-size: 11px; }
  tr:hover { background: #161b22; }
  .icon { margin-right: 6px; }
  .stream { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; max-height: 400px; overflow-y: auto; }
  .stream-line { padding: 2px 0; font-size: 13px; }
  .msg { background: #161b22; padding: 8px; border-radius: 6px; margin: 4px 0; border-left: 3px solid #58a6ff; }
  .section-title { font-size: 14px; color: #8b949e; margin: 16px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
  .progress { height: 6px; background: #21262d; border-radius: 3px; overflow: hidden; margin-bottom: 16px; }
  .progress-bar { height: 100%; background: #3fb950; transition: width 0.5s; border-radius: 3px; }
  .connection { position: fixed; top: 8px; right: 16px; font-size: 12px; }
  .connected { color: #3fb950; } .disconnected { color: #f85149; }
</style>
</head>
<body>
<div class="connection" id="conn">🟢 connected</div>
<h1>📊 ZCAC Cluster Dashboard</h1>
<div class="status-bar" id="statusBar">Loading…</div>
<div class="progress"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>
<div class="section-title">Agents</div>
<table id="taskTable"><thead><tr><th></th><th>Role</th><th>Kind</th><th>Status</th><th>Duration</th><th>Attempt</th><th>Summary</th></tr></thead><tbody id="taskBody"></tbody></table>
<div class="section-title">Messages</div>
<div id="messages"></div>
<div class="section-title">Event Stream</div>
<div class="stream" id="eventStream"></div>
<script>
const evtSource = new EventSource('/api/events');
let lastSeq = 0;
evtSource.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === 'snapshot' || data.type === 'event') {
    fetchSnapshot();
    if (data.event) {
      lastSeq = Math.max(lastSeq, data.event.sequence || 0);
      addEventLine(data.event);
    }
  }
};
evtSource.onerror = () => {
  document.getElementById('conn').textContent = '🔴 disconnected';
  document.getElementById('conn').className = 'connection disconnected';
};
evtSource.onopen = () => {
  document.getElementById('conn').textContent = '🟢 connected';
  document.getElementById('conn').className = 'connection connected';
};

function addEventLine(event) {
  const icons = { RUN_CREATED:'🚀',RUN_STARTED:'▶️',RUN_COMPLETED:'✅',RUN_FAILED:'❌',
    TASK_CREATED:'📋',TASK_READY:'🟡',TASK_STARTED:'⚙️',TASK_SUCCEEDED:'✅',TASK_FAILED:'❌',
    TASK_RETRY:'🔄',TASK_BLOCKED:'🔒',AGENT_ASSIGNED:'👤',AGENT_RELEASED:'👋',
    ARTIFACT_CREATED:'📦',WORKTREE_CREATED:'🌲',WORKTREE_REMOVED:'🗑️',
    MERGE_STARTED:'🔀',MERGE_COMPLETED:'🔀',MERGE_CONFLICT:'⚠️',SUPERVISOR_DECISION:'🧠',ERROR:'💥' };
  const icon = icons[event.type] || '•';
  const div = document.createElement('div');
  div.className = 'stream-line';
  const detail = event.payload ? JSON.stringify(event.payload).slice(0, 100) : '';
  div.innerHTML = icon + ' <span style="color:#8b949e">#' + (event.sequence||'') + '</span> ' + event.type +
    (event.taskId ? ' <span style="color:#58a6ff">' + event.taskId.slice(0,13) + '</span>' : '') +
    ' <span style="color:#8b949e">' + detail + '</span>';
  const stream = document.getElementById('eventStream');
  stream.insertBefore(div, stream.firstChild);
}

async function fetchSnapshot() {
  try {
    const res = await fetch('/api/snapshot');
    const data = await res.json();
    render(data);
  } catch {}
}

function render(data) {
  if (!data.run) { document.getElementById('statusBar').textContent = 'No active run'; return; }
  const tasks = data.tasks || [];
  const succeeded = tasks.filter(t => t.status === 'succeeded').length;
  const running = tasks.filter(t => t.status === 'running').length;
  const failed = tasks.filter(t => t.status === 'failed').length;
  const elapsed = data.elapsedSec !== undefined ? data.elapsedSec : 0;
  const progress = tasks.length > 0 ? Math.round((succeeded / tasks.length) * 100) : 0;

  document.getElementById('progressBar').style.width = progress + '%';
  document.getElementById('statusBar').innerHTML =
    '<div class="status-item"><div class="label">Status</div><div class="value ' +
    (data.run.status === 'completed' ? 'green' : data.run.status === 'failed' ? 'red' : 'blue') +
    '">' + data.run.status + '</div></div>' +
    '<div class="status-item"><div class="label">Elapsed</div><div class="value">' +
    Math.floor(elapsed/60) + 'm ' + (elapsed%60) + 's</div></div>' +
    '<div class="status-item"><div class="label">Tasks</div><div class="value">' + tasks.length + '</div></div>' +
    '<div class="status-item"><div class="label">✅</div><div class="value green">' + succeeded + '</div></div>' +
    '<div class="status-item"><div class="label">⚙️</div><div class="value yellow">' + running + '</div></div>' +
    '<div class="status-item"><div class="label">❌</div><div class="value red">' + failed + '</div></div>';

  const icons = { pending:'⏳',ready:'🟡',running:'⚙️',blocked:'🔒',succeeded:'✅',failed:'❌',retry_wait:'🔄',cancelled:'🚫' };
  const body = document.getElementById('taskBody');
  body.innerHTML = tasks.map(t => {
    const icon = icons[t.status] || '?';
    const dur = t.startedAt ? (t.completedAt ? Math.round((t.completedAt - t.startedAt)/1000)+'s' : Math.round((Date.now()-t.startedAt)/1000)+'s…') : '—';
    const attempt = t.attempt > 1 ? ' r' + t.attempt : '';
    const summary = (t.outputSummary || t.errorCode || '').slice(0, 40);
    return '<tr><td><span class="icon">' + icon + '</span></td><td>' + (t.role||'') + '</td><td>' + t.kind +
      '</td><td>' + t.status + '</td><td>' + dur + '</td><td>' + attempt + '</td><td>' + summary + '</td></tr>';
  }).join('');

  const msgDiv = document.getElementById('messages');
  msgDiv.innerHTML = (data.messages || []).map(m =>
    '<div class="msg"><strong>' + m.fromAgent + '</strong> → <strong>' + m.toAgent + '</strong>: ' +
    m.content.slice(0, 80) + '</div>').join('');
}

fetchSnapshot();
setInterval(fetchSnapshot, 3000);
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
    this.server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/" || url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML_PAGE);
        return;
      }
      if (url === "/api/snapshot") {
        this.#json(res, this.#snapshot());
        return;
      }
      if (url === "/api/events") {
        // SSE 流
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        this.#sseClients.add(res);
        // 心跳保活
        const heartbeat = setInterval(() => {
          res.write(": heartbeat\n\n");
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

  /** 事件到达时推送 SSE 给所有已连接客户端。 */
  broadcastEvent(event: ClusterEvent): void {
    const data = JSON.stringify({ type: "event", event });
    for (const client of this.#sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  }

  #snapshot(): Record<string, unknown> {
    const run = this.#deps.getRun();
    const tasks = this.#deps.getTasks();
    const runId = run?.id ?? "";
    const messages = runId ? this.#deps.getMessages(runId) : [];
    const now = Date.now();
    const startedAts = tasks.map((t) => t.startedAt ?? t.createdAt);
    const earliest = startedAts.length > 0 ? Math.min(...startedAts) : now;
    const elapsedSec = Math.round((now - earliest) / 1000);

    return {
      run: run ? { id: run.id, status: run.status } : null,
      elapsedSec,
      tasks: tasks.map((t) => ({
        kind: t.kind,
        role: t.input.role ?? "coder",
        status: t.status,
        attempt: t.attempt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        outputSummary: t.output?.summary,
        errorCode: t.error?.code,
      })),
      messages: messages.slice(-10).map((m) => ({
        fromAgent: m.fromAgent,
        toAgent: m.toAgent,
        content: m.content.slice(0, 100),
      })),
      recentEvents: this.#deps.getEvents(runId).slice(-20).map((e) => ({
        sequence: e.sequence,
        type: e.type,
        taskId: e.taskId,
      })),
    };
  }

  #json(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
  }

  stop(): void {
    this.server?.close();
  }
}
