/**
 * ZCAC Phase 15 — 实时 Web Dashboard(HTTP + SSE, ZCode 原生风格)。
 *
 * 浏览器打开即看 agent 实时活动:
 *   - 侧边栏: agent 列表(点击展开对话式详情)
 *   - 主面板: 选中 agent 的任务时间线(思考/工具/输出)
 *   - 底部:   实时事件流
 *
 * 端点:
 *   GET /                → HTML 仪表盘(SSE + 自动刷新)
 *   GET /api/snapshot    → JSON 全量状态
 *   GET /api/events      → SSE 实时事件流
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

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function buildSnapshot(deps: DashboardServerDeps) {
  const run = deps.getRun();
  const tasks = deps.getTasks();
  const runId = run?.id ?? "";
  const messages = runId ? deps.getMessages(runId) : [];
  const events = deps.getEvents(runId);
  const now = Date.now();

  return {
    run: run ? { id: run.id, status: run.status, createdAt: run.createdAt } : null,
    tasks: tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      role: t.input.role ?? "coder",
      status: t.status,
      attempt: t.attempt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      prompt: t.input.prompt?.slice(0, 800),
      outputSummary: t.output?.summary ?? t.output?.response?.slice(0, 500),
      outputResponse: t.output?.response?.slice(0, 2000),
      findings: t.output?.findings,
      errorCode: t.error?.code,
      errorMessage: t.error?.message,
      dependencies: t.dependencies,
      roleModel: t.input.model,
    })),
    messages: messages.slice(-30).map((m) => ({
      id: m.id, threadId: m.threadId, from: m.fromAgent, to: m.toAgent,
      type: m.type, content: m.content.slice(0, 500), taskId: m.taskId,
      createdAt: m.createdAt,
    })),
    events: events.slice(-100).map((e) => ({
      sequence: e.sequence, type: e.type, taskId: e.taskId,
      payload: e.payload, timestamp: e.timestamp,
    })),
  };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// HTML Page
// ---------------------------------------------------------------------------

function buildPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>ZCAC — Cluster</title>
<style>
:root{--bg:#1a1b26;--bg-dark:#16161e;--bg-panel:#1f2335;--bg-hover:#24283b;--border:#2f334d;--fg:#c0caf5;--fg-dim:#565f89;--fg-bright:#a9b1d6;--blue:#7aa2f7;--green:#9ece6a;--red:#f7768e;--yellow:#e0af68;--purple:#bb9af7;--cyan:#7dcfff;--orange:#ff9e64;--r:6px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg-dark);color:var(--fg);font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

.topbar{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:var(--bg-panel);border-bottom:1px solid var(--border);flex-shrink:0}
.topbar h1{font-size:14px;font-weight:600;color:var(--fg-bright)}
.topbar .right{display:flex;gap:12px;align-items:center;font-size:12px;color:var(--fg-dim)}
.badge{padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600}
.badge.running{background:#1a2e1a;color:var(--green)}.badge.completed{background:#1a2e1a;color:var(--green)}
.badge.failed{background:#2d1a1e;color:var(--red)}.badge.created{background:#1a2135;color:var(--blue)}

.progress-track{height:3px;background:var(--border);flex-shrink:0}
.progress-bar{height:100%;background:var(--green);transition:width .5s ease}

.layout{display:flex;flex:1;overflow:hidden}

.sidebar{width:240px;background:var(--bg-dark);border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0}
.sidebar-header{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--fg-dim);padding:10px 12px 4px}
.agent-row{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-left:2px solid transparent}
.agent-row:hover{background:var(--bg-hover)}
.agent-row.active{background:var(--bg-panel);border-left-color:var(--blue)}
.agent-icon{font-size:16px;flex-shrink:0}
.agent-info{flex:1;min-width:0}
.agent-name{font-size:12px;font-weight:600;color:var(--fg-bright)}
.agent-sub{font-size:11px;color:var(--fg-dim)}
.agent-status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-running{background:var(--yellow);animation:pulse 1.5s infinite}
.dot-succeeded{background:var(--green)}.dot-failed{background:var(--red)}
.dot-blocked{background:var(--fg-dim)}.dot-pending{background:var(--fg-dim);opacity:.4}
@keyframes pulse{50%{opacity:.3}}

.content{flex:1;overflow-y:auto;padding:16px}

/* Conversation-style timeline */
.turn-card{background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--r);margin-bottom:10px;overflow:hidden}
.turn-header{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer}
.turn-header:hover{background:var(--bg-hover)}
.turn-icon{font-size:18px;flex-shrink:0}
.turn-role{font-weight:600;font-size:13px;color:var(--fg-bright)}
.turn-kind{font-size:12px;color:var(--fg-dim);margin-left:4px}
.turn-badge{margin-left:auto;font-size:11px;padding:2px 10px;border-radius:10px;font-weight:600}
.turn-badge.succeeded{background:#1a2e1a;color:var(--green)}
.turn-badge.running{background:#2d2a1e;color:var(--yellow)}
.turn-badge.failed{background:#2d1a1e;color:var(--red)}
.turn-badge.blocked{background:#1a2135;color:var(--fg-dim)}
.turn-badge.pending{background:#1a2135;color:var(--fg-dim)}
.turn-duration{font-size:11px;color:var(--fg-dim)}

.turn-body{border-top:1px solid var(--border);padding:12px 14px}
.timeline{position:relative;padding-left:20px}
.timeline::before{content:'';position:absolute;left:7px;top:4px;bottom:4px;width:1px;background:var(--border)}
.tl-item{position:relative;padding:4px 0;margin-bottom:4px}
.tl-item::before{content:'';position:absolute;left:-17px;top:9px;width:7px;height:7px;border-radius:50%;background:var(--blue)}
.tl-item:last-child::before{background:var(--green)}
.tl-label{font-size:11px;color:var(--fg-dim);text-transform:uppercase;margin-bottom:2px}
.tl-value{font-size:12px;color:var(--fg-bright);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto}
.tl-value.code{background:var(--bg);padding:6px 8px;border-radius:4px;font-family:monospace;font-size:11px}

/* Event stream bottom */
.event-bar{border-top:1px solid var(--border);background:var(--bg-dark);height:180px;overflow-y:auto;flex-shrink:0;padding:6px 12px}
.event-bar .sidebar-header{padding:4px 0 6px}
.event-line{display:flex;gap:8px;padding:2px 0;font-size:12px;font-family:monospace}
.event-seq{color:var(--fg-dim);min-width:36px}
.event-icon{margin-right:4px}

.conn{position:fixed;top:8px;right:16px;font-size:11px;z-index:100}
.conn-ok{color:var(--green)}.conn-err{color:var(--red)}

.progress-track{height:3px;background:var(--border);flex-shrink:0}
.progress-bar{height:100%;background:var(--green);transition:width .5s ease}

.empty-state{display:flex;align-items:center;justify-content:center;height:100%;color:var(--fg-dim);font-size:14px;text-align:center}
</style>
</head>
<body>
<div class="conn conn-ok" id="conn">🟢 SSE</div>
<div class="topbar">
  <h1>📊 ZCAC Cluster</h1>
  <div class="right">
    <span id="elapsed">—</span>
    <span class="badge" id="runBadge">—</span>
  </div>
</div>
<div class="progress-track"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>
<div class="layout">
  <div class="sidebar">
    <div class="sidebar-header">Agents</div>
    <div id="agentList"><div style="padding:12px;color:var(--fg-dim);font-size:12px">No run</div></div>
  </div>
  <div class="content" id="mainContent">
    <div class="empty-state">Start a run with /cluster to see agent activity</div>
  </div>
</div>
<div class="event-bar">
  <div class="sidebar-header">Event Stream</div>
  <div id="eventLines"></div>
</div>
<script>
let cursor=0, selectedAgent=null;
const $=id=>document.getElementById(id);
function esc(s){const d=document.createElement('div');d.textContent=String(s??'');return d.innerHTML}

async function fetchSnap(){
  try{
    const r=await fetch('/api/snapshot');
    render(await r.json());
  }catch(e){console.error(e)}
}

function render(data){
  if(!data.run){$('mainContent').innerHTML='<div class="empty-state">No active run</div>';return}
  const tasks=data.tasks||[];
  const ok=tasks.filter(t=>t.status==='succeeded').length;
  const running=tasks.filter(t=>t.status==='running').length;
  const failed=tasks.filter(t=>t.status==='failed').length;
  const progress=tasks.length>0?Math.round(ok/tasks.length*100):0;

  $('runBadge').textContent=data.run.status;
  $('runBadge').className='badge '+data.run.status;
  $('progressBar').style.width=progress+'%';

  const firstStart=Math.min(...tasks.map(t=>t.startedAt||Date.now()),Date.now());
  const elapsed=Math.round((Date.now()-firstStart)/1000);
  $('elapsed').textContent=(elapsed>=60?Math.floor(elapsed/60)+'m ':'')+(elapsed%60)+'s';

  // Sidebar agents
  const byRole={};
  tasks.forEach(t=>{
    const role=t.role;
    if(!byRole[role])byRole[role]={status:t.status,count:0,kind:t.kind,attempts:[]};
    byRole[role].count++;
    byRole[role].attempts.push(t);
    if(t.status==='running')byRole[role].status='running';
    if(t.status==='failed')byRole[role].status='failed';
  });
  const roleIcons={coder:'📝','frontend-coder':'🎨','backend-coder':'⚙️',explorer:'🔍',planner:'📋',
    tester:'🧪',reviewer:'🔍','ux-designer':'📐','ui-designer':'🎨','market-researcher':'📊',
    'integration-tester':'🔗',devops:'🔧',supervisor:'🧠'};
  const selectedRole=selectedAgent;
  $('agentList').innerHTML=Object.entries(byRole).map(([role,info])=>{
    const dot=info.status==='running'?'running':info.status==='failed'?'failed':'succeeded';
    const icon=roleIcons[role]||'🤖';
    const active=selectedRole===role?'active':'';
    return '<div class="agent-row '+active+'" onclick="selectAgent(\\''+role+'\\')">'
      +'<span class="agent-icon">'+icon+'</span>'
      +'<div class="agent-info"><div class="agent-name">'+esc(role)+'</div>'
      +'<div class="agent-sub">'+info.count+' task'+(info.count>1?'s':'')+'</div></div>'
      +'<span class="agent-status-dot dot-'+dot+'"></span></div>';
  }).join('');

  // Main content: selected agent or all
  const visibleTasks=selectedAgent?tasks.filter(t=>t.role===selectedAgent):tasks;
  renderTasks(visibleTasks, data.messages||[]);
}

function renderTasks(tasks,messages){
  const icons={pending:'⏳',ready:'🟡',running:'⚙️',blocked:'🔒',succeeded:'✅',failed:'❌',retry_wait:'🔄'};
  const roleIcons={coder:'📝','frontend-coder':'🎨','backend-coder':'⚙️',explorer:'🔍',planner:'📋',
    tester:'🧪',reviewer:'🔍','ux-designer':'📐','ui-designer':'🎨','market-researcher':'📊'};

  if(tasks.length===0){$('mainContent').innerHTML='<div class="empty-state">No tasks</div>';return}

  $('mainContent').innerHTML=tasks.map(t=>{
    const icon=icons[t.status]||'?';
    const ri=roleIcons[t.role]||'🤖';
    const dur=t.startedAt?(t.completedAt?Math.round((t.completedAt-t.startedAt)/1000)+'s':Math.round((Date.now()-t.startedAt)/1000)+'s…'):'—';
    const attempt=t.attempt>1?' <span style="color:var(--yellow)">r'+t.attempt+'</span>':'';
    const model=t.roleModel?'<span style="color:var(--fg-dim);font-size:11px;margin-left:4px">'+esc(t.roleModel)+'</span>':'';

    // Timeline items
    const tl=[];
    tl.push('<div class="tl-item"><div class="tl-label">Prompt</div><div class="tl-value code">'+esc(t.prompt?.slice(0,300)||'')+'</div></div>');
    if(t.outputSummary||t.outputResponse){
      tl.push('<div class="tl-item"><div class="tl-label">Output</div><div class="tl-value">'+esc((t.outputSummary||t.outputResponse||'').slice(0,300))+'</div></div>');
    }
    if(t.errorCode){
      tl.push('<div class="tl-item"><div class="tl-label" style="color:var(--red)">Error</div><div class="tl-value" style="color:var(--red)">'+esc(t.errorMessage||t.errorCode)+'</div></div>');
    }

    return '<div class="turn-card">'
      +'<div class="turn-header">'
      +'<span class="turn-icon">'+ri+'</span>'
      +'<span class="turn-role">'+esc(t.role)+'</span>'
      +'<span class="turn-kind">'+esc(t.kind)+'</span>'
      +'<span class="turn-badge '+t.status+'">'+t.status+'</span>'
      +'<span class="turn-duration">'+dur+attempt+'</span>'
      +'</div>'
      +'<div class="turn-body"><div class="timeline">'+tl.join('')+'</div></div>'
      +'</div>';
  }).join('') + renderMessages(messages);
}

function renderMessages(messages){
  if(!messages||messages.length===0)return'';
  const items=messages.map(m=>
    '<div class="msg-item"><span class="msg-from">'+esc(m.from)+'</span> → <span class="msg-to">'+esc(m.to)+'</span>: '+esc(m.content).slice(0,80)+'</div>'
  ).join('');
  return '<div class="section-title" style="font-size:12px;color:var(--fg-dim);margin:16px 0 8px">📨 Messages</div>'+items;
}

function selectAgent(role){
  selectedAgent=selectedAgent===role?null:role;
  fetchSnap();
}

// SSE
const evtSource=new EventSource('/api/events');
evtSource.onmessage=e=>{
  const d=JSON.parse(e.data);
  if(d.type==='event'&&d.event){
    const ev=d.event;
    if(ev.sequence>cursor)cursor=ev.sequence;
    addEventLine(ev);
  }
};
evtSource.onerror=()=>{$('conn').textContent='🔴 SSE';$('conn').className='conn conn-err'};
evtSource.onopen=()=>{$('conn').textContent='🟢 SSE';$('conn').className='conn conn-ok'};

function addEventLine(ev){
  const icons={RUN_CREATED:'🚀',RUN_STARTED:'▶️',RUN_COMPLETED:'✅',RUN_FAILED:'❌',
    TASK_CREATED:'📋',TASK_READY:'🟡',TASK_STARTED:'⚙️',TASK_SUCCEEDED:'✅',TASK_FAILED:'❌',
    TASK_RETRY:'🔄',TASK_BLOCKED:'🔒',AGENT_ASSIGNED:'👤',AGENT_RELEASED:'👋',
    ARTIFACT_CREATED:'📦',WORKTREE_CREATED:'🌲',WORKTREE_REMOVED:'🗑️',
    MERGE_STARTED:'🔀',MERGE_COMPLETED:'🔀',MERGE_CONFLICT:'⚠️',SUPERVISOR_DECISION:'🧠'};
  const icon=icons[ev.type]||'•';
  const div=document.createElement('div');
  div.className='event-line';
  const detail=ev.payload?JSON.stringify(ev.payload).slice(0,100):'';
  div.innerHTML='<span class="event-seq">#'+(ev.sequence||'')+'</span>'
    +'<span><span class="event-icon">'+icon+'</span>'+esc(ev.type)+'</span>'
    +(ev.taskId?' <span style="color:var(--blue)">'+ev.taskId.slice(0,13)+'</span>':'')
    +' <span style="color:var(--fg-dim)">'+esc(detail)+'</span>';
  const el=$('eventLines');
  el.insertBefore(div,el.firstChild);
  while(el.children.length>200)el.removeChild(el.lastChild);
}

fetchSnap();
setInterval(fetchSnap,3000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

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
        res.end(buildPage());
        return;
      }
      if (url === "/api/snapshot") {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(buildSnapshot(this.#deps)));
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
        const hb = setInterval(() => {
          try { res.write(": hb\n\n"); } catch { /* gone */ }
        }, 15_000);
        req.on("close", () => {
          clearInterval(hb);
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
      try { client.write(data); } catch { /* disconnected */ }
    }
  }

  stop(): void {
    this.server?.close();
  }
}
