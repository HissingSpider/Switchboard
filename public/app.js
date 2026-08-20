// Switchboard dashboard. One SSE stream feeds everything; the REST API is only
// used for things that aren't in the event log (history, cost, config).

const $ = (sel) => document.querySelector(sel);
const state = { runs: [], selected: null, events: [], projects: [], agents: [], verbose: false };

/** A paired device holds its own token; on the Mac Mini itself there is none
 *  and loopback is trusted. */
const deviceToken = () => localStorage.getItem('swb-token');

const api = async (path, init = {}) => {
  const token = deviceToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) {
    // The token was revoked from the Setup tab; send this device back to pairing.
    localStorage.removeItem('swb-token');
    location.replace('/pair.html');
  }
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
    // Leaving Live and coming back should land on the list, not on whichever
    // run happened to be open before.
    if (btn.dataset.tab !== 'live') setView('list');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'board') loadBoard();
    if (btn.dataset.tab === 'cost') loadCost();
    if (btn.dataset.tab === 'inbox') loadInbox();
    if (btn.dataset.tab === 'skills') loadSkills();
    if (btn.dataset.tab === 'setup') loadSetup();
  };
}

// ----------------------------------------------------------------- status
async function refreshStatus() {
  const s = await api('/api/status');
  const summary = `${s.active}/${s.capacity} running · ${s.queued} queued · $${s.monthSpendUsd.toFixed(2)}/$${s.monthBudgetUsd} this month · ${s.skills} skills`;
  // A halt is the only thing worth reading when there is one: "0 running" is
  // true and useless if nothing *can* run.
  $('#summary').textContent = s.halted ? `⚠ ${s.halted.message} ${s.halted.remedy}` : summary;
  $('#summary').classList.toggle('halted', Boolean(s.halted));
  await refreshConfirmations();
}

async function refreshConfirmations() {
  const { pending } = await api('/api/confirmations');
  const badge = $('#inbox-badge');
  badge.hidden = pending.length === 0;
  badge.textContent = String(pending.length);
  if ($('#tab-inbox').classList.contains('active')) loadInbox();
}

async function answer(id, approve) {
  await api(`/api/confirmations/${id}`, { method: 'POST', body: JSON.stringify({ approve }) });
  await refreshConfirmations();
  await loadInbox();
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
  for (const card of document.querySelectorAll('.runcard')) card.onclick = () => selectRun(card.dataset.id, { user: true });
  if (!state.selected && runs[0]) selectRun(runs[0].id);
}

/**
 * On a phone the run list and the run itself are two screens rather than two
 * columns; on a wide screen `data-view` is set but nothing reads it. Pushing a
 * history entry means the phone's back gesture returns to the list instead of
 * leaving the app, which is what anyone actually expects from a Home Screen icon.
 */
const isPhone = () => window.matchMedia('(max-width: 640px)').matches;

function setView(view, { push = false } = {}) {
  document.body.dataset.view = view;
  if (push && isPhone()) history.pushState({ view }, '');
  if (view === 'list') window.scrollTo(0, 0);
}
setView('list');

window.addEventListener('popstate', () => setView('list'));

async function selectRun(id, opts = {}) {
  state.selected = id;
  if (opts.user) setView('detail', { push: true });
  const { run, artifacts, children } = await api(`/api/runs/${id}`);
  const { events } = await api(`/api/runs/${id}/events`);
  state.events = events;

  const hasDiff = artifacts.some((a) => a.name === 'changes.diff');
  $('#runhead').innerHTML =
    `<button class="backbtn" id="backbtn">‹ Runs</button>` +
    `<b>${run.id}</b> <span class="dim">${run.status} · ${run.project ?? 'scratch'} · ${run.agent ?? 'default'} · ${run.taskClass} · ${esc(run.model ?? 'default model')} · ${run.turns} turns · $${run.costUsd.toFixed(3)}</span>` +
    (run.branch ? ` <span class="dim">· ${esc(run.branch)}</span>` : '') +
    (hasDiff ? ` <button id="showdiff">diff</button>` : '') +
    ` <button id="verbose">${state.verbose ? 'hide detail' : 'show detail'}</button>` +
    (children?.length ? ` <span class="dim">· ${children.length} child run(s)</span>` : '');
  $('#backbtn').onclick = () => (history.state?.view === 'detail' ? history.back() : setView('list'));
  if (hasDiff) $('#showdiff').onclick = () => showDiff(run.id);
  $('#verbose').onclick = () => {
    state.verbose = !state.verbose;
    $('#verbose').textContent = state.verbose ? 'hide detail' : 'show detail';
    renderEvents();
  };

  $('#followup').hidden = !(run.status === 'running' || run.status === 'queued');
  renderEvents();
  await refreshRuns();
}

/**
 * Minimal markdown, applied after escaping so it can never inject markup.
 * Covers what a model actually emits in a reply — fences, inline code, bold,
 * lists — and deliberately nothing else.
 */
function md(text) {
  const blocks = [];
  let out = esc(text)
    // Fenced code first, held aside so nothing else rewrites its contents.
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<pre class="code"><code>${code.replace(/\n$/, '')}</code></pre>`);
      return `&lt;&lt;block:${blocks.length - 1}&gt;&gt;`;
    })
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  out = out
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split('\n').filter(Boolean);
      if (!lines.length) return '';
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-*]\s+/, '')}</li>`).join('')}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${l.replace(/^\s*\d+[.)]\s+/, '')}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('');

  // Must match the sentinel emitted above and nothing else. A bare \d+ here
  // rewrites every number in the prose into `undefined`.
  return out.replace(/&lt;&lt;block:(\d+)&gt;&gt;/g, (_, i) => blocks[Number(i)] ?? '');
}

/** Machinery rather than conversation. Hidden unless you ask for detail. */
const NOISE = new Set(['usage.update', 'agent.thinking', 'tool.result', 'run.progress', 'notify.sent', 'notify.suppressed', 'message.out']);

const TOOL_ICON = { Read: '□', Write: '✎', Edit: '✎', Bash: '›', Grep: '⌕', Glob: '⌕', WebFetch: '↗', WebSearch: '⌕', Task: '⌥' };

const shortPath = (t) => String(t ?? '').replace(/^\/Users\/[^/]+\//, '~/');

function renderEvents() {
  const box = $('#events');
  const stuck = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const visible = state.events.filter((e) => state.verbose || !NOISE.has(e.kind));

  let lastMinute = '';
  const rows = visible.map((e) => {
    const minute = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const stamp = minute === lastMinute ? '' : `<div class="when">${minute}</div>`;
    lastMinute = minute;
    return stamp + renderEvent(e);
  });

  box.innerHTML = rows.join('') || '<div class="empty">nothing yet</div>';
  if (stuck) box.scrollTop = box.scrollHeight;
}

function renderEvent(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case 'agent.text':
      return `<div class="say">${md(d.text ?? e.summary)}</div>`;
    case 'agent.question':
      return `<div class="say asking">${md(d.text ?? e.summary)}</div>`;

    case 'tool.use': {
      const icon = TOOL_ICON[d.tool] ?? '·';
      const detail = shortPath(d.tool === 'Bash' ? d.input?.command : (d.input?.file_path ?? d.input?.url ?? d.input?.pattern ?? ''));
      return `<div class="act"><span class="ic">${icon}</span><span class="tool">${esc(d.tool ?? '')}</span><span class="arg">${esc(detail)}</span></div>`;
    }

    case 'action.gated': {
      if (d.tier === 'allow') return `<div class="act sub"><span class="ic">✓</span><span class="tool"></span><span class="arg">allowed ${esc(d.tool ?? '')}</span></div>`;
      return `<div class="note ${d.tier === 'deny' ? 'bad' : 'warn'}">${d.tier === 'deny' ? 'blocked' : 'needs approval'}: ${esc(d.tool ?? '')} — ${esc(String(d.reason ?? ''))}</div>`;
    }

    case 'action.confirm_requested':
      return `<div class="note warn">${esc(e.summary)}</div>`;
    case 'action.confirm_answered':
    case 'action.denied':
      return `<div class="note">${esc(e.summary)}</div>`;

    case 'run.queued':
    case 'run.started':
    case 'git.branch':
      return `<div class="rule"><span>${esc(e.summary)}</span></div>`;
    case 'run.finished':
      return `<div class="rule ok"><span>${esc(e.summary)}</span></div>`;
    case 'run.failed':
    case 'run.killed':
    case 'run.stuck':
    case 'system.error':
      return `<div class="rule bad"><span>${esc(e.summary)}</span></div>`;

    case 'git.diff':
    case 'artifact.saved':
      return `<div class="note">${esc(e.summary)}</div>`;

    default:
      return `<div class="act sub"><span class="ic">·</span><span class="tool">${esc(e.kind)}</span><span class="arg">${esc(e.summary.slice(0, 160))}</span></div>`;
  }
}

// ------------------------------------------------------------------- SSE
// EventSource reconnects on its own and resends Last-Event-ID, so the server
// can replay exactly what was missed. We track the id anyway for the manual
// reconnect path, because a phone that was asleep often gets a clean close
// rather than an error.
let lastEventId = 0;

function setOffline(off) {
  $('#offline').hidden = !off;
}

function connect() {
  const token = deviceToken();
  const params = new URLSearchParams();
  if (lastEventId) params.set('since', String(lastEventId));
  if (token) params.set('token', token);
  const es = new EventSource(`/events${params.toString() ? `?${params}` : ''}`);
  es.onopen = () => setOffline(false);
  es.onmessage = (msg) => {
    if (msg.lastEventId) lastEventId = Number(msg.lastEventId);
    const ev = JSON.parse(msg.data);
    if (ev.id > lastEventId) lastEventId = ev.id;
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
  es.onerror = () => {
    setOffline(true);
    setTimeout(() => {
      if (es.readyState === 2) connect();
    }, 3000);
  };
}

// Coming back from the lock screen is the common case, and neither `onerror`
// nor `onopen` necessarily fires — so ask for the gap explicitly.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  refreshStatus().catch(() => setOffline(true));
  refreshRuns().catch(() => undefined);
});

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
  selectRun(run.id, { user: true });
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
      selectRun(tr.dataset.id, { user: true });
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
     <h3 class="section">By project</h3>
     <table><tr><th>project</th><th>runs</th><th>spend</th></tr>` +
    c.byProject.map((p) => `<tr><td>${esc(p.project)}</td><td class="mono">${p.runs}</td><td class="mono">$${Number(p.costUsd).toFixed(2)}</td></tr>`).join('') +
    `</table>
     <h3 class="section">By model</h3>
     <p class="hint">Lanes pick the model: chat and read-only answers run cheap, real work runs on the default. If <code>(default)</code> owns the bill, something is routing everything to the top tier.</p>
     <table><tr><th>model</th><th>runs</th><th>spend</th><th>avg</th></tr>` +
    (c.byModel ?? [])
      .map(
        (m) => `<tr><td class="mono">${esc(m.model)}</td><td class="mono">${m.runs}</td><td class="mono">$${Number(m.costUsd).toFixed(2)}</td><td class="mono">$${(Number(m.costUsd) / Math.max(1, m.runs)).toFixed(3)}</td></tr>`,
      )
      .join('') +
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

// ----------------------------------------------------------------- inbox

async function loadInbox() {
  const { pending, audit } = await api('/api/confirmations');
  $('#inbox').innerHTML = pending.length
    ? pending
        .map(
          (c) => `<div class="approval">
            <div class="what"><b>${esc(c.runId)}</b> wants to <b>${esc(c.tool)}</b></div>
            <div class="detail">${esc(c.detail)}</div>
            <div class="row">
              <button data-approve="${c.id}">Approve</button>
              <button class="danger" data-deny="${c.id}">Deny</button>
              <span class="sub">${esc(c.id)} · asked ${ago(c.createdAt)}</span>
            </div>
          </div>`,
        )
        .join('')
    : '<p class="hint">Nothing waiting.</p>';

  for (const b of $('#inbox').querySelectorAll('[data-approve]')) b.onclick = () => answer(b.dataset.approve, true);
  for (const b of $('#inbox').querySelectorAll('[data-deny]')) b.onclick = () => answer(b.dataset.deny, false);

  $('#inbox-audit').innerHTML = audit
    .filter((c) => c.status !== 'pending')
    .slice(0, 25)
    .map(
      (c) => `<div class="answered">
        <span class="st-${c.status}">${esc(c.status)}</span>
        <span>${esc(c.tool)}</span>
        <span class="dim">${esc(c.detail.slice(0, 70))}</span>
        <span class="dim">${c.answeredBy ? esc(c.answeredBy) : 'no reply'}</span>
      </div>`,
    )
    .join('');
}

function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ---------------------------------------------------------------- skills

async function loadSkills() {
  const [{ queue, stale }, all] = await Promise.all([api('/api/skills/review'), api('/api/skills')]);
  const badge = $('#skills-badge');
  const needsMe = queue.filter((s) => s.flagged || s.proposal);
  badge.hidden = needsMe.length === 0;
  badge.textContent = String(needsMe.length);

  $('#skills-review').innerHTML = queue.length
    ? queue.map(skillCard).join('')
    : '<p class="hint">Nothing needs review.</p>';

  const byName = new Map(all.skills.map((s) => [s.name, s]));
  $('#skills-all').innerHTML =
    all.skills
      .map((s) => {
        const rec = queue.find((q) => q.name === s.name);
        return `<div class="skill">
          <h4>${esc(s.name)} ${rec ? tierPill(rec.trust) : ''}</h4>
          <div class="desc">${esc(s.description)}</div>
        </div>`;
      })
      .join('') || '<p class="hint">No skills yet.</p>';
  void byName;
  void stale;
  wireSkillButtons();
}

const tierPill = (t) => `<span class="tier tier-${t}">${t}</span>`;

function skillCard(s) {
  const rate = s.successRate === undefined ? 'never used' : `${Math.round(s.successRate * 100)}% over ${s.runs}`;
  return `<div class="skill ${s.flagged ? 'flagged' : ''}">
    <h4>${esc(s.name)} ${tierPill(s.trust)} ${s.flagged ? '<span class="tier tier-sandboxed">flagged</span>' : ''}</h4>
    <div class="meta">${rate}${s.lastUsedAt ? ` · last used ${ago(s.lastUsedAt)}` : ''}${s.authoredBy ? ` · written by ${esc(s.authoredBy)}` : ' · hand-written'}</div>
    ${s.originTask ? `<div class="desc">for: ${esc(s.originTask)}</div>` : ''}
    ${s.flagReason ? `<div class="desc">flagged: ${esc(s.flagReason)}</div>` : ''}
    ${s.proposal ? `<div class="proposal">${esc(s.proposal)}</div>` : ''}
    <div class="row">
      ${s.proposal ? `<button data-trust="${s.name}">Grant trusted</button>` : ''}
      ${s.flagged ? `<button data-unflag="${s.name}">Clear flag</button>` : ''}
      ${s.retiredAt ? `<button data-restore="${s.name}">Restore</button>` : `<button class="danger" data-retire="${s.name}">Retire</button>`}
    </div>
  </div>`;
}

function wireSkillButtons() {
  const act = async (name, path, body) => {
    await api(`/api/skills/${name}${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
    await loadSkills();
  };
  for (const b of document.querySelectorAll('[data-trust]')) b.onclick = () => act(b.dataset.trust, '/trust', { trust: 'trusted' });
  for (const b of document.querySelectorAll('[data-unflag]')) b.onclick = () => act(b.dataset.unflag, '/unflag');
  for (const b of document.querySelectorAll('[data-retire]')) b.onclick = () => act(b.dataset.retire, '/retire', { reason: 'retired from the dashboard' });
  for (const b of document.querySelectorAll('[data-restore]')) b.onclick = () => act(b.dataset.restore, '/restore');
}

// ----------------------------------------------------------------- setup

async function loadSetup() {
  await loadConfig();
  await refreshPushState();
  await refreshDevices();
  const r = await api('/api/reachability');
  $('#reach').textContent = [
    `tailscale: ${r.tailscale.installed ? (r.tailscale.running ? `running as ${r.tailscale.hostname ?? r.tailscale.ip}` : 'installed, not running') : 'not installed'}`,
    ...r.urls.map((u) => `  ${u}`),
    ...r.problems.map((p) => `! ${p}`),
    ...r.advice.map((a) => `→ ${a}`),
  ].join('\n');
}

async function refreshDevices() {
  const { devices } = await api('/api/devices');
  $('#devices').innerHTML =
    devices
      .map(
        (d) => `<div class="device">
          <div>
            <div>${esc(d.name)}${d.revokedAt ? ' (revoked)' : ''}</div>
            <div class="sub">${esc(d.id)} · ${d.lastSeenAt ? `seen ${ago(d.lastSeenAt)}` : 'never seen'}</div>
          </div>
          ${d.revokedAt ? '' : `<button class="danger" data-revoke="${d.id}">Revoke</button>`}
        </div>`,
      )
      .join('') || '<p class="hint">No paired devices.</p>';
  for (const b of $('#devices').querySelectorAll('[data-revoke]')) {
    b.onclick = async () => {
      await api(`/api/devices/${b.dataset.revoke}`, { method: 'DELETE' });
      await refreshDevices();
    };
  }
}

$('#new-pair').onclick = async () => {
  const { code, expiresAt } = await api('/api/devices/pair', { method: 'POST' });
  $('#pair-code').textContent = code;
  $('#pair-code').title = `expires ${new Date(expiresAt).toLocaleTimeString()}`;
};

// ------------------------------------------------------------------ push

async function refreshPushState() {
  const el = $('#push-state');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.textContent = 'This browser cannot receive push notifications.';
    return;
  }
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  el.textContent = sub
    ? 'Notifications are on for this device.'
    : standalone
      ? 'Notifications are off.'
      : 'Notifications are off. On iPhone, add to the Home Screen first.';
}

$('#enable-push').onclick = async () => {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      $('#push-state').textContent = `Permission ${permission}.`;
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, deviceId: localStorage.getItem('swb-device-id') }),
    });
    await refreshPushState();
  } catch (err) {
    $('#push-state').textContent = `Could not enable: ${err.message}`;
  }
};

$('#test-push').onclick = async () => {
  const r = await api('/api/push/test', { method: 'POST' });
  $('#push-state').textContent = `Sent to ${r.sent} device(s)${r.failed ? `, ${r.failed} failed` : ''}.`;
};

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// Deep link from a notification: /?tab=inbox or /?confirm=c-xxxx
const params = new URLSearchParams(location.search);
if (params.get('tab') || params.get('confirm')) {
  const target = params.get('confirm') ? 'inbox' : params.get('tab');
  document.querySelector(`nav button[data-tab="${target}"]`)?.click();
}
