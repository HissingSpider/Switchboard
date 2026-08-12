// Switchboard dashboard. One SSE stream feeds everything; the REST API is only
// used for things that aren't in the event log (history, cost, config).

const $ = (sel) => document.querySelector(sel);
const state = { runs: [], selected: null, events: [], projects: [], agents: [] };

const api = async (path, init) => {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ------------------------------------------------------------------ tabs
for (const btn of document.querySelectorAll('nav button')) {
  btn.onclick = () => {
    for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b === btn);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`);
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'board') loadBoard();
    if (btn.dataset.tab === 'cost') loadCost();
    if (btn.dataset.tab === 'config') loadConfig();
  };
}

// ----------------------------------------------------------------- status
async function refreshStatus() {
  const s = await api('/api/status');
  $('#summary').textContent =
    `${s.active}/${s.capacity} running · ${s.queued} queued · $${s.monthSpendUsd.toFixed(2)}/$${s.monthBudgetUsd} this month · ${s.skills} skills`;
  await refreshConfirmations();
}

async function refreshConfirmations() {
  const { pending } = await api('/api/confirmations');
  const box = $('#confirmations');
  box.hidden = pending.length === 0;
  box.innerHTML = pending
    .map(
      (c) => `<div class="confirm">
        <code>${esc(c.id)}</code>
        <span><b>${esc(c.runId)}</b> wants to <b>${esc(c.tool)}</b>: ${esc(c.detail.slice(0, 160))}</span>
        <button data-approve="${c.id}">approve</button>
        <button class="danger" data-deny="${c.id}">deny</button>
      </div>`,
    )
    .join('');
  for (const b of box.querySelectorAll('[data-approve]')) {
    b.onclick = () => answer(b.dataset.approve, true);
  }
  for (const b of box.querySelectorAll('[data-deny]')) {
    b.onclick = () => answer(b.dataset.deny, false);
  }
}

async function answer(id, approve) {
  await api(`/api/confirmations/${id}`, { method: 'POST', body: JSON.stringify({ approve }) });
  await refreshConfirmations();
}

// ------------------------------------------------------------------- runs
async function refreshRuns() {
  const { runs } = await api('/api/runs?limit=40');
  state.runs = runs;
  $('#runlist').innerHTML = runs
    .map(
      (r) => `<div class="runcard st-${r.status} ${r.id === state.selected ? 'sel' : ''}" data-id="${r.id}">
        <div><span class="id">${r.id}</span> <span class="meta">${r.status} · ${r.project ?? 'scratch'} · $${r.costUsd.toFixed(3)}</span></div>
        <div class="prompt">${esc(r.prompt)}</div>
      </div>`,
    )
    .join('');
  for (const card of document.querySelectorAll('.runcard')) card.onclick = () => selectRun(card.dataset.id);
  if (!state.selected && runs[0]) selectRun(runs[0].id);
}

async function selectRun(id) {
  state.selected = id;
  const { run, artifacts, children } = await api(`/api/runs/${id}`);
  const { events } = await api(`/api/runs/${id}/events`);
  state.events = events;

  const hasDiff = artifacts.some((a) => a.name === 'changes.diff');
  $('#runhead').innerHTML =
    `<b>${run.id}</b> <span class="dim">${run.status} · ${run.project ?? 'scratch'} · ${run.agent ?? 'default'} · ${run.taskClass} · ${run.turns} turns · $${run.costUsd.toFixed(3)}</span>` +
    (run.branch ? ` <span class="dim">· ${esc(run.branch)}</span>` : '') +
    (hasDiff ? ` <button id="showdiff">diff</button>` : '') +
    (children?.length ? ` <span class="dim">· ${children.length} child run(s)</span>` : '');
  if (hasDiff) $('#showdiff').onclick = () => showDiff(run.id);

  $('#followup').hidden = !(run.status === 'running' || run.status === 'queued');
  renderEvents();
  await refreshRuns();
}

function renderEvents() {
  $('#events').innerHTML = state.events
    .map(
      (e) => `<div class="ev k-${e.kind.replace('.', '-')}">
        <span class="t">${time(e.ts)}</span>
        <span class="k">${esc(e.kind)}</span>
        <span class="s">${esc(e.summary)}</span>
      </div>`,
    )
    .join('');
  const box = $('#events');
  box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------- SSE
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.runId && ev.runId === state.selected) {
      state.events.push(ev);
      renderEvents();
    }
    if (['run.queued', 'run.started', 'run.finished', 'run.failed', 'run.killed'].includes(ev.kind)) {
      refreshRuns();
      refreshStatus();
    }
    if (ev.kind.startsWith('action.')) refreshConfirmations();
  };
  es.onerror = () => setTimeout(() => es.readyState === 2 && connect(), 3000);
}

// ---------------------------------------------------------------- submit
$('#submit').onsubmit = async (e) => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (!prompt) return;
  const body = {
    prompt,
    project: $('#project').value || undefined,
    agent: $('#agent').value || undefined,
    taskClass: $('#class').value || undefined,
    threadId: 'dashboard',
  };
  const { run } = await api('/api/runs', { method: 'POST', body: JSON.stringify(body) });
  $('#prompt').value = '';
  await refreshRuns();
  selectRun(run.id);
};
$('#prompt').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#submit').requestSubmit();
};

$('#followup').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#followtext').value.trim();
  if (!text || !state.selected) return;
  await api(`/api/runs/${state.selected}/followup`, { method: 'POST', body: JSON.stringify({ text }) });
  $('#followtext').value = '';
};
$('#killbtn').onclick = async () => {
  if (state.selected) await api(`/api/runs/${state.selected}`, { method: 'DELETE' });
};

// ------------------------------------------------------------------ diff
async function showDiff(id) {
  const res = await fetch(`/api/runs/${id}/diff`);
  const text = await res.text();
  $('#difftitle').textContent = `${id} — changes.diff`;
  $('#diff').innerHTML = text
    .split('\n')
    .map((line) => {
      const cls = line.startsWith('+++') || line.startsWith('---') ? 'dim' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
      return `<span class="${cls}">${esc(line)}</span>`;
    })
    .join('\n');
  $('#diffbox').showModal();
}
$('#diffclose').onclick = () => $('#diffbox').close();

// --------------------------------------------------------------- history
async function loadHistory() {
  const params = new URLSearchParams({ limit: '200' });
  if ($('#search').value) params.set('q', $('#search').value);
  if ($('#filter-status').value) params.set('status', $('#filter-status').value);
  if ($('#filter-project').value) params.set('project', $('#filter-project').value);
  const { runs } = await api(`/api/runs?${params}`);
  $('#history').innerHTML =
    `<tr><th>id</th><th>when</th><th>status</th><th>project</th><th>agent</th><th>cost</th><th>prompt</th></tr>` +
    runs
      .map(
        (r) => `<tr data-id="${r.id}">
          <td class="mono">${r.id}</td>
          <td class="mono">${new Date(r.createdAt).toLocaleString()}</td>
          <td>${r.status}</td>
          <td>${esc(r.project ?? '-')}</td>
          <td>${esc(r.agent ?? '-')}</td>
          <td class="mono">$${r.costUsd.toFixed(3)}</td>
          <td>${esc(r.prompt.slice(0, 90))}</td>
        </tr>`,
      )
      .join('');
  for (const tr of $('#history').querySelectorAll('tr[data-id]')) {
    tr.onclick = () => {
      document.querySelector('nav button[data-tab="live"]').click();
      selectRun(tr.dataset.id);
    };
  }
}
$('#search').oninput = debounce(loadHistory, 250);
$('#filter-status').onchange = loadHistory;
$('#filter-project').onchange = loadHistory;

// ----------------------------------------------------------------- board
async function loadBoard() {
  const data = await api('/api/board');
  if (!data.board) {
    $('#board').innerHTML = `<div class="col"><h3>DeerDawn board</h3><div class="card">${esc(data.hint)}</div></div>`;
    return;
  }
  const columns = data.board.columns ?? data.board;
  $('#board').innerHTML = Object.entries(columns)
    .map(
      ([name, cards]) => `<div class="col"><h3>${esc(name)} (${cards.length})</h3>${cards
        .map((c) => `<div class="card">${esc(typeof c === 'string' ? c : c.title)}</div>`)
        .join('')}</div>`,
    )
    .join('');
}

// ------------------------------------------------------------------ cost
async function loadCost() {
  const c = await api('/api/cost');
  const pct = Math.min(100, (c.monthSpendUsd / c.monthBudgetUsd) * 100);
  $('#cost').innerHTML =
    `<h2>$${c.monthSpendUsd.toFixed(2)} <span class="dim">of $${c.monthBudgetUsd} this month</span></h2>
     <div class="bar ${pct >= 100 ? 'over' : ''}"><div style="width:${pct}%"></div></div>
     <table><tr><th>project</th><th>runs</th><th>spend</th></tr>` +
    c.byProject.map((p) => `<tr><td>${esc(p.project)}</td><td class="mono">${p.runs}</td><td class="mono">$${Number(p.costUsd).toFixed(2)}</td></tr>`).join('') +
    `</table>`;
}

// ---------------------------------------------------------------- config
async function loadConfig() {
  const [projects, agents, skills, schedules] = await Promise.all([
    api('/api/projects'),
    api('/api/agents'),
    api('/api/skills'),
    api('/api/schedules'),
  ]);
  const section = (title, rows) => `<div class="col"><h3>${title}</h3>${rows.join('') || '<div class="card">none</div>'}</div>`;
  $('#config').innerHTML =
    `<div class="board">` +
    section('Projects', projects.projects.map((p) => `<div class="card">${esc(p.name)} <span class="dim">${p.exists ? p.path : `MISSING ${p.path}`}</span></div>`)) +
    section('Agents', agents.agents.map((a) => `<div class="card">${esc(a.name)} <span class="dim">${esc(a.description ?? a.taskClass ?? '')}</span></div>`)) +
    section('Skills', skills.skills.map((s) => `<div class="card">${esc(s.name)} <span class="dim">${esc(s.description.slice(0, 80))}</span></div>`)) +
    section('Schedules', schedules.jobs.map((j) => `<div class="card">${esc(j.name)} <span class="dim">${esc(j.spec)}${j.next ? ` → ${new Date(j.next).toLocaleString()}` : ''}</span></div>`)) +
    `</div>`;
}

// ------------------------------------------------------------------ init
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

async function init() {
  const [{ projects }, { agents }] = await Promise.all([api('/api/projects'), api('/api/agents')]);
  state.projects = projects;
  state.agents = agents;
  for (const sel of ['#project', '#filter-project']) {
    $(sel).innerHTML =
      ($(sel).children[0]?.outerHTML ?? '') + projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  }
  $('#agent').innerHTML = `<option value="">default agent</option>` + agents.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('');
  await refreshStatus();
  await refreshRuns();
  connect();
  setInterval(refreshStatus, 15000);
}

init().catch((err) => ($('#summary').textContent = `error: ${err.message}`));
