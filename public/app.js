// Switchboard console. One SSE stream feeds everything; the REST API is only
// used for what isn't in the event log (history, cost, config, devices).
//
// The shape of the UI: a project rail on the left, the runs for whichever
// project is selected, the transcript of one run, and that run's detail. On a
// phone the middle two are one screen at a time and the rail becomes a tab bar.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  runs: [],
  selected: null,
  selectedRun: null,
  events: [],
  projects: [],
  agents: [],
  pending: [],
  verbose: false,
  /** null = every project. '' is a real value: the scratch directory. */
  project: null,
  view: 'live',
};

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
    // The token was revoked from Settings; send this device back to pairing.
    localStorage.removeItem('swb-token');
    location.replace('/pair.html');
  }
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shortPath = (t) => String(t ?? '').replace(/^\/Users\/[^/]+\//, '~/');
const money = (n) => `$${Number(n ?? 0).toFixed(Number(n) >= 10 ? 2 : 3)}`;

function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/**
 * A project is named in full. The short key (`swb`) is what you type and text;
 * it is never what you read. `label` in config wins; failing that the directory
 * name, un-camel-cased, which turns BlueHorseshoe into Blue Horseshoe.
 */
function projectLabel(p) {
  if (p.label) return p.label;
  const base = String(p.path ?? '').replace(/\/+$/, '').split('/').pop() ?? p.name;
  const words = base.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const labelFor = (name) => {
  if (name === null || name === undefined) return 'All projects';
  // '(none)' is what the spend query calls a run with no project.
  if (name === '' || name === '(none)') return 'No project';
  const p = state.projects.find((x) => x.name === name);
  return p ? projectLabel(p) : name;
};

// ------------------------------------------------------------------- views

function showView(name) {
  state.view = name;
  for (const b of $$('.railrow[data-view], .tabbtn[data-view]')) b.classList.toggle('active', b.dataset.view === name);
  for (const v of $$('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  // Coming back to Live should land on the list, not on whichever run happened
  // to be open when you left.
  if (name !== 'live') setView('list');
  const load = { history: loadHistory, tasks: loadBoard, cost: loadCost, inbox: loadInbox, skills: loadSkills, setup: loadSetup }[name];
  load?.();
}

for (const b of $$('.railrow[data-view], .tabbtn[data-view]')) b.onclick = () => showView(b.dataset.view);

/**
 * On a phone the run list and the run itself are two screens rather than two
 * columns; on a wide screen `data-view` is set but nothing reads it. Pushing a
 * history entry means the phone's back gesture returns to the list instead of
 * leaving the app, which is what anyone expects from a Home Screen icon.
 */
const isPhone = () => window.matchMedia('(max-width: 980px)').matches;

function setView(view, { push = false } = {}) {
  document.body.dataset.view = view;
  if (push && isPhone()) history.pushState({ view }, '');
}
setView('list');
window.addEventListener('popstate', () => setView('list'));

// ---------------------------------------------------------------- projects

function renderProjects() {
  const counts = new Map();
  for (const r of state.runs) {
    if (r.status !== 'running' && r.status !== 'queued') continue;
    const k = r.project ?? '';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const row = (key, label, sub, extra = '') => {
    const n = key === null ? [...counts.values()].reduce((a, b) => a + b, 0) : (counts.get(key) ?? 0);
    return `<button class="railrow projrow ${extra} ${state.project === key ? 'active' : ''}" data-project="${key === null ? '' : esc(key)}" data-all="${key === null}">
      <span class="dot"></span>
      <span class="grow">
        <span class="label">${esc(label)}</span>
        ${sub ? `<span class="path">${esc(sub)}</span>` : ''}
      </span>
      ${n ? `<span class="count">${n}</span>` : ''}
    </button>`;
  };

  $('#projects').innerHTML = [
    row(null, 'All projects', ''),
    ...state.projects.map((p) => row(p.name, projectLabel(p), shortPath(p.path), p.exists === false ? 'missing' : '')),
    row('', 'No project', 'Scratch directory, no git'),
  ].join('');

  for (const b of $('#projects').querySelectorAll('[data-project]')) {
    b.onclick = () => selectProject(b.dataset.all === 'true' ? null : b.dataset.project);
  }
}

function selectProject(key) {
  state.project = key;
  $('#runs-title').textContent = labelFor(key);
  // The composer follows the rail: picking a project is how you say where the
  // next thing should run.
  if (key !== null) $('#project').value = key;
  $('#runs-project').value = key === null ? '*' : key;
  renderProjects();
  showView('live');
  refreshRuns();
}

// ------------------------------------------------------------------ status

async function refreshStatus() {
  const s = await api('/api/status');
  const health = $('#health');
  if (s.halted) {
    // A halt is the only thing worth reading when there is one: "0 running" is
    // true and useless if nothing *can* run.
    health.className = 'healthline halted';
    health.innerHTML = `<span class="dot"></span><span>${esc(s.halted.message)} ${esc(s.halted.remedy)}</span>`;
  } else {
    health.className = 'healthline';
    health.innerHTML = `<span class="dot"></span><span>Daemon healthy · ${s.active} of ${s.capacity} slots busy${s.queued ? ` · ${s.queued} queued` : ''} · ${s.skills} skills</span>`;
  }

  const pct = Math.min(100, (s.monthSpendUsd / Math.max(1, s.monthBudgetUsd)) * 100);
  $('#spend').textContent = `$${s.monthSpendUsd.toFixed(2)}`;
  $('#budget').textContent = `/ $${s.monthBudgetUsd}`;
  const meter = $('#budget-meter');
  meter.className = `meter ${pct >= 100 ? 'over' : pct >= 80 ? 'hot' : ''}`;
  meter.firstElementChild.style.width = `${pct}%`;

  await refreshConfirmations();
}

// ----------------------------------------------------------- confirmations

async function refreshConfirmations() {
  const { pending } = await api('/api/confirmations');
  const before = state.pending.map((c) => c.id).join();
  state.pending = pending;
  for (const id of ['#inbox-badge', '#tab-badge']) {
    const badge = $(id);
    badge.hidden = pending.length === 0;
    badge.textContent = String(pending.length);
  }
  // The transcript renders a pending confirmation as buttons and an answered
  // one as a line of text, so it has to be redrawn when that flips.
  if (before !== pending.map((c) => c.id).join()) {
    renderEvents();
    paintRunlistFlags();
    renderDetail();
  }
  if (state.view === 'inbox') loadInbox();
}

const pendingById = (id) => state.pending.find((c) => c.id === id);

/**
 * Answer one confirmation. `always` additionally turns it into a standing rule
 * — the server is what decides whether that is allowed, and refuses for
 * anything gated by shape rather than by profile.
 */
async function answer(id, approve, always = false) {
  for (const b of document.querySelectorAll(`[data-cid="${id}"]`)) b.disabled = true;
  await api(`/api/confirmations/${id}`, { method: 'POST', body: JSON.stringify({ approve, always }) });
  await refreshConfirmations();
  if (state.view === 'inbox') await loadInbox();
  if (state.view === 'setup') await loadRules();
}

/** Buttons live inside innerHTML that is rebuilt constantly, so they are wired
 *  once by delegation rather than re-bound on every render. */
function wireApprovals(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-cid]');
    if (!btn) return;
    e.preventDefault();
    answer(btn.dataset.cid, btn.dataset.act !== 'deny', btn.dataset.act === 'always');
  });
}
wireApprovals($('#events'));
wireApprovals($('#inbox'));

/** One approval, rendered the same way in the transcript and in the inbox. */
function approvalCard(c, { showRun = true } = {}) {
  const always = c.alwaysSpec
    ? `<button class="btn" data-cid="${esc(c.id)}" data-act="always" title="Remember this answer as a rule">Always allow <span class="always-spec">${esc(c.alwaysSpec)}</span></button>`
    : '';
  return `<div class="approval">
    <div class="what">
      <span class="verb">Needs your approval</span>
      <span class="tool">${esc(c.tool)}</span>
      <span class="grow"></span>
      ${showRun ? `<span class="who">${esc(c.runId)}</span>` : ''}
    </div>
    <div class="detail">${esc(c.detail)}</div>
    <div class="actions">
      <button class="btn btn-ok" data-cid="${esc(c.id)}" data-act="approve">Approve once</button>
      ${always}
      <button class="btn btn-danger" data-cid="${esc(c.id)}" data-act="deny">Deny</button>
      <span class="sub">${esc(c.id)} · asked ${ago(c.createdAt)}</span>
      ${c.alwaysSpec ? `<div class="always-why">Remembers <code>${esc(c.alwaysSpec)}</code> as a standing rule, revocable under Settings. Anything that pushes, publishes, sends, buys or deletes is never offered here.</div>` : ''}
    </div>
  </div>`;
}

/** A run with something waiting on you should say so from the list. */
function paintRunlistFlags() {
  const waiting = new Set(state.pending.map((c) => c.runId));
  for (const card of document.querySelectorAll('.runcard')) {
    card.classList.toggle('needsyou', waiting.has(card.dataset.id));
  }
}

// -------------------------------------------------------------------- runs

async function refreshRuns() {
  const params = new URLSearchParams({ limit: '40' });
  if (state.project !== null) params.set('project', state.project);
  const { runs } = await api(`/api/runs?${params}`);
  state.runs = runs;
  $('#runcount').textContent = runs.length ? `${runs.length} recent` : '';
  $('#nav-runs').textContent = runs.length ? String(runs.length) : '';

  const waiting = new Set(state.pending.map((c) => c.runId));
  $('#runlist').innerHTML =
    runs
      .map((r) => {
        const status = waiting.has(r.id) ? 'waiting' : r.status;
        const label = waiting.has(r.id) ? 'waiting on you' : r.status;
        return `<div class="runcard ${r.id === state.selected ? 'sel' : ''}" data-id="${esc(r.id)}">
          <div class="top">
            <span class="pill st-${esc(status)}">${esc(label)}</span>
            <span class="grow"></span>
            <span class="id">${esc(r.id)}</span>
          </div>
          <div class="prompt">${esc(r.prompt)}</div>
          <div class="top">
            <span class="sub">${esc(labelFor(r.project ?? ''))} · ${ago(r.createdAt)}</span>
            <span class="grow"></span>
            <span class="cost">${money(r.costUsd)}</span>
          </div>
        </div>`;
      })
      .join('') || '<p class="hint">Nothing here yet. Say something below to start.</p>';

  for (const card of document.querySelectorAll('.runcard')) card.onclick = () => selectRun(card.dataset.id, { user: true });
  paintRunlistFlags();
  renderProjects();
  if (!state.selected && runs[0]) selectRun(runs[0].id);
}

function clearSelection() {
  state.selected = null;
  state.selectedRun = null;
  state.events = [];
  $('#runhead').innerHTML = `<div class="titles"><div class="title">New thread</div><div class="sub">${esc(labelFor(state.project))}</div></div>`;
  $('#events').innerHTML = '<p class="hint">Nothing running. Whatever you send starts a new run.</p>';
  renderComposer();
  renderDetail();
  for (const c of document.querySelectorAll('.runcard.sel')) c.classList.remove('sel');
}

async function selectRun(id, opts = {}) {
  state.selected = id;
  if (opts.user) setView('detail', { push: true });

  const { run, artifacts, children } = await api(`/api/runs/${id}`);
  const { events } = await api(`/api/runs/${id}/events`);
  state.selectedRun = { ...run, artifacts: artifacts ?? [], children: children ?? [] };
  state.events = events;

  const hasDiff = (artifacts ?? []).some((a) => a.name === 'changes.diff');
  const live = run.status === 'running' || run.status === 'queued';

  $('#runhead').innerHTML =
    `<button class="btn btn-ghost btn-sm backbtn" id="backbtn">‹ Runs</button>
     <div class="titles">
       <div class="title">${esc(run.prompt)}</div>
       <div class="sub">${esc(labelFor(run.project ?? ''))} · ${esc(run.id)} · ${clock(run.createdAt)} · ${run.turns} turn${run.turns === 1 ? '' : 's'} · ${money(run.costUsd)}</div>
     </div>
     <span class="grow"></span>
     <div class="tools">
       ${hasDiff ? '<button class="btn btn-sm" id="showdiff">Diff</button>' : ''}
       <button class="btn btn-sm btn-ghost" id="verbose">${state.verbose ? 'Hide detail' : 'Show detail'}</button>
       ${live ? '<button class="btn btn-sm btn-danger" id="killbtn">Stop</button>' : '<button class="btn btn-sm" id="newthread2">New thread</button>'}
     </div>`;

  $('#backbtn').onclick = () => (history.state?.view === 'detail' ? history.back() : setView('list'));
  if (hasDiff) $('#showdiff').onclick = () => showDiff(run.id);
  $('#verbose').onclick = () => {
    state.verbose = !state.verbose;
    $('#verbose').textContent = state.verbose ? 'Hide detail' : 'Show detail';
    renderEvents();
  };
  if (live) $('#killbtn').onclick = () => api(`/api/runs/${run.id}`, { method: 'DELETE' });
  else $('#newthread2').onclick = clearSelection;

  // A follow-up thread almost always belongs where the last one did, so the
  // composer follows the run you are reading.
  if (!live) $('#project').value = run.project ?? '';

  renderEvents();
  renderComposer();
  renderDetail();
  await refreshRuns();
}

// ------------------------------------------------------------- transcript

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

function renderEvents() {
  const box = $('#events');
  const stuck = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  const visible = state.events.filter((e) => state.verbose || !NOISE.has(e.kind));

  let lastMinute = '';
  const rows = visible.map((e) => {
    const minute = clock(e.ts);
    const stamp = minute === lastMinute ? '' : `<div class="when">${minute}</div>`;
    lastMinute = minute;
    return stamp + renderEvent(e);
  });

  box.innerHTML = rows.join('') || '<div class="empty">Nothing yet.</div>';
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
      // A standing rule doing its job is worth one visible line: an action that
      // used to stop and ask now does not, and that should never be silent.
      if (d.standing) return `<div class="act"><span class="ic">✓</span><span class="tool">${esc(d.tool ?? '')}</span><span class="arg">auto-allowed by your standing rule ${esc(String(d.rule ?? ''))}</span></div>`;
      if (d.tier === 'allow') return `<div class="act sub"><span class="ic">✓</span><span class="tool"></span><span class="arg">allowed ${esc(d.tool ?? '')}</span></div>`;
      return `<div class="note ${d.tier === 'deny' ? 'bad' : 'warn'}">${d.tier === 'deny' ? 'blocked' : 'needs approval'}: ${esc(d.tool ?? '')} — ${esc(String(d.reason ?? ''))}</div>`;
    }

    case 'action.confirm_requested': {
      // While it is still open this is the one thing in the transcript you can
      // act on, so it is buttons rather than a sentence telling you to go and
      // find them somewhere else.
      const open = pendingById(String(d.confirmId ?? ''));
      return open ? approvalCard(open, { showRun: false }) : `<div class="note warn">${esc(e.summary)}</div>`;
    }
    case 'action.confirm_answered':
      return `<div class="note ${String(d.status) === 'approved' ? 'ok' : 'bad'}">${esc(e.summary)}</div>`;
    case 'action.denied':
      return `<div class="note bad">${esc(e.summary)}</div>`;

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

// ------------------------------------------------------------ detail rail

function renderDetail() {
  const run = state.selectedRun;
  $('#detail-id').textContent = run ? run.id : '';
  if (!run) {
    $('#detail').innerHTML = '<p class="empty">No run selected.</p>';
    return;
  }

  const waiting = state.pending.some((c) => c.runId === run.id);
  const fact = (k, v, mono = false) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v ${mono ? 'mono' : ''}">${esc(v)}</div></div>`;

  const others = state.runs.filter((r) => r.id !== run.id && (r.status === 'running' || r.status === 'queued'));
  const hasDiff = run.artifacts.some((a) => a.name === 'changes.diff');

  $('#detail').innerHTML = [
    `<div class="facts">
      ${fact('Status', waiting ? 'Waiting on you' : run.status)}
      ${fact('Started', clock(run.createdAt))}
      ${fact('Spent', money(run.costUsd), true)}
      ${fact('Turns', String(run.turns), true)}
    </div>`,

    '<div class="hr"></div>',

    `<div class="block">
      <div class="section">Working in</div>
      <div class="v">${esc(labelFor(run.project ?? ''))}</div>
      ${run.branch ? `<div class="filerow"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4.5" cy="4" r="1.8"/><circle cx="4.5" cy="12" r="1.8"/><circle cx="11.5" cy="8" r="1.8"/><path d="M4.5 5.8v4.4M6.2 4.6c3 0 3.6 1.4 3.6 2.6"/></svg><span class="name">${esc(run.branch)}</span></div>` : ''}
      <div class="filerow"><span class="name">${esc(run.agent ?? 'default agent')} · ${esc(run.taskClass ?? '—')} · ${esc(run.model ?? 'default model')}</span></div>
    </div>`,

    run.artifacts.length
      ? `<div class="hr"></div>
         <div class="block">
           <div class="section">Artifacts</div>
           ${run.artifacts.map((a) => `<div class="filerow"><span class="name">${esc(a.name)}</span>${a.name === 'changes.diff' ? '<button class="btn btn-sm btn-ghost" data-diff="' + esc(run.id) + '">Open</button>' : ''}</div>`).join('')}
           ${hasDiff ? '<div class="aside">Only files this run wrote itself are committed. Anything you changed while it worked stays in the working tree, uncommitted.</div>' : ''}
         </div>`
      : '',

    run.children.length
      ? `<div class="hr"></div>
         <div class="block">
           <div class="section">Child runs</div>
           ${run.children.map((c) => `<div class="filerow"><span class="name">${esc(c.id ?? c)}</span></div>`).join('')}
         </div>`
      : '',

    others.length
      ? `<div class="hr"></div>
         <div class="block">
           <div class="section">Also running</div>
           ${others
             .map(
               (r) => `<button class="railrow" data-goto="${esc(r.id)}" style="padding:10px 12px;border:1px solid var(--line)">
                 <span class="dot" style="width:7px;height:7px;border-radius:50%;background:${r.status === 'running' ? 'var(--accent)' : 'var(--dim)'}"></span>
                 <span class="grow"><span class="label">${esc(r.prompt.slice(0, 60))}</span><span class="path">${esc(labelFor(r.project ?? ''))} · ${esc(r.status)}</span></span>
               </button>`,
             )
             .join('')}
         </div>`
      : '',
  ].join('');

  for (const b of $('#detail').querySelectorAll('[data-diff]')) b.onclick = () => showDiff(b.dataset.diff);
  for (const b of $('#detail').querySelectorAll('[data-goto]')) b.onclick = () => selectRun(b.dataset.goto, { user: true });
}

// --------------------------------------------------------------------- SSE
// EventSource reconnects on its own and resends Last-Event-ID, so the server
// can replay exactly what was missed. We track the id anyway for the manual
// reconnect path, because a phone that was asleep often gets a clean close
// rather than an error.
let lastEventId = 0;

const setOffline = (off) => ($('#offline').hidden = !off);

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
      // The run header carries status, turns and cost, all of which are only
      // final once the run is. Without this it keeps saying "running" over a
      // transcript that plainly ended.
      if (ev.runId && ev.runId === state.selected) selectRun(ev.runId);
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

// ---------------------------------------------------------------- composer

/** The composer is one box with two jobs: start a run, or talk to the one that
 *  is still going. Which one it is has to be readable without clicking. */
function renderComposer() {
  const run = state.selectedRun;
  const live = run && (run.status === 'running' || run.status === 'queued');
  $('#replyto').hidden = !live;
  if (live) $('#replyto-id').textContent = run.id;
  $('#prompt').placeholder = live ? 'Say something to this run…  (⌘↵ to send)' : 'Ask a question, or give it a task…  (⌘↵ to send)';
  $('#sendbtn').textContent = live ? 'Reply' : 'Send';
  // Where a follow-up goes is decided; the selects would be lying.
  for (const id of ['#project', '#class', '#agent']) $(id).disabled = Boolean(live);
}

$('#newthread').onclick = clearSelection;

$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#prompt').value.trim();
  if (!text) return;
  const run = state.selectedRun;
  const live = run && (run.status === 'running' || run.status === 'queued');

  $('#sendbtn').disabled = true;
  try {
    if (live) {
      await api(`/api/runs/${run.id}/followup`, { method: 'POST', body: JSON.stringify({ text }) });
      $('#prompt').value = '';
    } else {
      const body = {
        prompt: text,
        project: $('#project').value || undefined,
        agent: $('#agent').value || undefined,
        taskClass: $('#class').value || undefined,
        threadId: 'dashboard',
      };
      const { run: created } = await api('/api/runs', { method: 'POST', body: JSON.stringify(body) });
      $('#prompt').value = '';
      await refreshRuns();
      await selectRun(created.id, { user: true });
    }
  } finally {
    $('#sendbtn').disabled = false;
  }
};

$('#prompt').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#composer').requestSubmit();
};
// Grow with the text rather than scrolling a two-line box.
$('#prompt').oninput = () => {
  const el = $('#prompt');
  el.style.height = 'auto';
  el.style.height = `${Math.min(190, el.scrollHeight)}px`;
};

// -------------------------------------------------------------------- diff

async function showDiff(id) {
  const res = await fetch(`/api/runs/${id}/diff`, {
    headers: deviceToken() ? { authorization: `Bearer ${deviceToken()}` } : {},
  });
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

// ----------------------------------------------------------------- history

async function loadHistory() {
  const params = new URLSearchParams({ limit: '200' });
  if ($('#search').value) params.set('q', $('#search').value);
  if ($('#filter-status').value) params.set('status', $('#filter-status').value);
  if ($('#filter-project').value) params.set('project', $('#filter-project').value);
  const { runs } = await api(`/api/runs?${params}`);
  $('#history').innerHTML =
    `<thead><tr><th>Run</th><th>When</th><th>Status</th><th>Project</th><th>Agent</th><th>Cost</th><th>Prompt</th></tr></thead><tbody>` +
    (runs
      .map(
        (r) => `<tr data-id="${esc(r.id)}">
          <td class="mono">${esc(r.id)}</td>
          <td class="mono">${new Date(r.createdAt).toLocaleString()}</td>
          <td><span class="pill st-${esc(r.status)}">${esc(r.status)}</span></td>
          <td>${esc(labelFor(r.project ?? ''))}</td>
          <td>${esc(r.agent ?? '—')}</td>
          <td class="mono">${money(r.costUsd)}</td>
          <td>${esc(r.prompt.slice(0, 90))}</td>
        </tr>`,
      )
      .join('') || `<tr><td colspan="7" class="dim">Nothing matches.</td></tr>`) +
    `</tbody>`;
  for (const tr of $('#history').querySelectorAll('tr[data-id]')) {
    tr.onclick = () => {
      showView('live');
      selectRun(tr.dataset.id, { user: true });
    };
  }
}
$('#search').oninput = debounce(loadHistory, 250);
$('#filter-status').onchange = loadHistory;
$('#filter-project').onchange = loadHistory;

// ------------------------------------------------------------------- board

async function loadBoard() {
  const data = await api('/api/board');
  if (!data.board) {
    $('#board').innerHTML = `<div class="col"><h3>DeerDawn board</h3><div class="card">${esc(data.hint)}</div></div>`;
    return;
  }
  const columns = data.board.columns ?? data.board;
  $('#board').innerHTML = Object.entries(columns)
    .map(
      ([name, cards]) => `<div class="col">
        <h3>${esc(name)} <span class="dim mono">${cards.length}</span></h3>
        ${cards.map((c) => `<div class="card">${esc(typeof c === 'string' ? c : c.title)}</div>`).join('') || '<p class="hint">Empty.</p>'}
      </div>`,
    )
    .join('');
}

// -------------------------------------------------------------------- cost

async function loadCost() {
  const c = await api('/api/cost');
  const pct = Math.min(100, (c.monthSpendUsd / c.monthBudgetUsd) * 100);
  $('#cost').innerHTML =
    `<div class="pagehead">
       <h2>Spend</h2>
       <div class="bignum"><b>$${c.monthSpendUsd.toFixed(2)}</b><span class="dim">of $${c.monthBudgetUsd} this month</span></div>
     </div>
     <div class="bar ${pct >= 100 ? 'over' : ''}" style="margin: 18px 0 26px"><div style="width:${pct}%"></div></div>
     <h3 class="section">By project</h3>
     <div class="panel scrollx" style="margin: 10px 0 26px"><table><thead><tr><th>Project</th><th>Runs</th><th>Spend</th></tr></thead><tbody>` +
    c.byProject.map((p) => `<tr><td>${esc(labelFor(p.project ?? ''))}</td><td class="mono">${p.runs}</td><td class="mono">$${Number(p.costUsd).toFixed(2)}</td></tr>`).join('') +
    `</tbody></table></div>
     <h3 class="section">By model</h3>
     <p class="hint" style="margin: 8px 0 10px">Lanes pick the model: chat and read-only answers run cheap, real work runs on the default. If <code>(default)</code> owns the bill, something is routing everything to the top tier.</p>
     <div class="panel scrollx"><table><thead><tr><th>Model</th><th>Runs</th><th>Spend</th><th>Avg</th></tr></thead><tbody>` +
    (c.byModel ?? [])
      .map(
        (m) => `<tr><td class="mono">${esc(m.model)}</td><td class="mono">${m.runs}</td><td class="mono">$${Number(m.costUsd).toFixed(2)}</td><td class="mono">$${(Number(m.costUsd) / Math.max(1, m.runs)).toFixed(3)}</td></tr>`,
      )
      .join('') +
    `</tbody></table></div>`;
}

// ------------------------------------------------------------------- inbox

async function loadInbox() {
  const { pending, audit } = await api('/api/confirmations');
  state.pending = pending;
  $('#inbox').innerHTML = pending.length ? pending.map((c) => approvalCard(c)).join('') : '<p class="hint">Nothing waiting.</p>';

  const answered = audit.filter((c) => c.status !== 'pending').slice(0, 25);
  $('#inbox-audit').innerHTML =
    answered
      .map(
        (c) => `<div class="answered">
        <span class="verdict st-${esc(c.status)}">${esc(c.status)}</span>
        <span class="tool">${esc(c.tool)}</span>
        <span class="detail">${esc(c.detail)}</span>
        <span class="dim who">${c.answeredBy ? esc(c.answeredBy) : 'no reply'} · ${ago(c.answeredAt ?? c.createdAt)}</span>
      </div>`,
      )
      .join('') || '<p class="hint">Nothing answered yet.</p>';
}

// --------------------------------------------------------- standing rules

async function loadRules() {
  const { rules } = await api('/api/rules');
  $('#rules').innerHTML = rules.length
    ? `<div class="rules">${rules
        .map(
          (r) => `<div class="rulecard">
            <div class="grow">
              <div class="spec">${esc(r.spec)}${r.mode === 'exact' ? ' <span class="dim">(exact)</span>' : ''}</div>
              <div class="meta">${r.uses} use${r.uses === 1 ? '' : 's'}${r.lastUsedAt ? `, last ${ago(r.lastUsedAt)}` : ''} · granted ${ago(r.createdAt)} by ${esc(r.createdBy)}${r.sample ? ` · for: ${esc(r.sample.slice(0, 60))}` : ''}</div>
            </div>
            <button class="btn btn-danger btn-sm" data-revoke-rule="${esc(r.id)}">Revoke</button>
          </div>`,
        )
        .join('')}</div>`
    : '<p class="hint">No standing approvals. Every gated action still asks.</p>';
  for (const b of $('#rules').querySelectorAll('[data-revoke-rule]')) {
    b.onclick = async () => {
      await api(`/api/rules/${b.dataset.revokeRule}`, { method: 'DELETE' });
      await loadRules();
    };
  }
}

// ------------------------------------------------------------------ skills

async function loadSkills() {
  const [{ queue }, all] = await Promise.all([api('/api/skills/review'), api('/api/skills')]);
  const needsMe = queue.filter((s) => s.flagged || s.proposal);
  const badge = $('#skills-badge');
  badge.hidden = needsMe.length === 0;
  badge.textContent = String(needsMe.length);

  $('#skills-review').innerHTML = queue.length ? queue.map(skillCard).join('') : '<p class="hint">Nothing needs review.</p>';

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
  wireSkillButtons();
}

const tierPill = (t) => `<span class="tier tier-${esc(t)}">${esc(t)}</span>`;

function skillCard(s) {
  const rate = s.successRate === undefined ? 'never used' : `${Math.round(s.successRate * 100)}% over ${s.runs}`;
  return `<div class="skill ${s.flagged ? 'flagged' : ''}">
    <h4>${esc(s.name)} ${tierPill(s.trust)} ${s.flagged ? '<span class="tier tier-sandboxed">flagged</span>' : ''}</h4>
    <div class="meta">${rate}${s.lastUsedAt ? ` · last used ${ago(s.lastUsedAt)}` : ''}${s.authoredBy ? ` · written by ${esc(s.authoredBy)}` : ' · hand-written'}</div>
    ${s.originTask ? `<div class="desc">for: ${esc(s.originTask)}</div>` : ''}
    ${s.flagReason ? `<div class="desc">flagged: ${esc(s.flagReason)}</div>` : ''}
    ${s.proposal ? `<div class="proposal">${esc(s.proposal)}</div>` : ''}
    <div class="row">
      ${s.proposal ? `<button class="btn btn-primary" data-trust="${esc(s.name)}">Grant trusted</button>` : ''}
      ${s.flagged ? `<button class="btn" data-unflag="${esc(s.name)}">Clear flag</button>` : ''}
      ${s.retiredAt ? `<button class="btn" data-restore="${esc(s.name)}">Restore</button>` : `<button class="btn btn-danger" data-retire="${esc(s.name)}">Retire</button>`}
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

// ---------------------------------------------------------------- settings

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
    section(
      'Projects',
      projects.projects.map(
        (p) => `<div class="card">${esc(projectLabel(p))}<span class="dim">${p.exists ? shortPath(p.path) : `MISSING ${shortPath(p.path)}`} · key: ${esc(p.name)}</span></div>`,
      ),
    ) +
    section('Agents', agents.agents.map((a) => `<div class="card">${esc(a.name)}<span class="dim">${esc(a.description ?? a.taskClass ?? '')}</span></div>`)) +
    section('Skills', skills.skills.map((s) => `<div class="card">${esc(s.name)}<span class="dim">${esc(s.description.slice(0, 80))}</span></div>`)) +
    section('Schedules', schedules.jobs.map((j) => `<div class="card">${esc(j.name)}<span class="dim">${esc(j.spec)}${j.next ? ` → ${new Date(j.next).toLocaleString()}` : ''}</span></div>`)) +
    `</div>`;
}

async function loadSetup() {
  await loadConfig();
  await loadRules();
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
          <div class="grow">
            <div>${esc(d.name)}${d.revokedAt ? ' (revoked)' : ''}</div>
            <div class="sub">${esc(d.id)} · ${d.lastSeenAt ? `seen ${ago(d.lastSeenAt)}` : 'never seen'}</div>
          </div>
          ${d.revokedAt ? '' : `<button class="btn btn-danger btn-sm" data-revoke="${esc(d.id)}">Revoke</button>`}
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

// -------------------------------------------------------------------- push

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

// -------------------------------------------------------------------- init

async function init() {
  const [{ projects }, { agents }] = await Promise.all([api('/api/projects'), api('/api/agents')]);
  state.projects = projects;
  state.agents = agents;

  const options = (first) =>
    first + projects.map((p) => `<option value="${esc(p.name)}">${esc(projectLabel(p))}</option>`).join('');
  $('#project').innerHTML = options('<option value="">No project (scratch)</option>');
  $('#filter-project').innerHTML = options('<option value="">Any project</option>');
  $('#runs-project').innerHTML = options('<option value="*">All projects</option>') + '<option value="">No project</option>';
  $('#runs-project').onchange = (e) => selectProject(e.target.value === '*' ? null : e.target.value);
  $('#agent').innerHTML = `<option value="">Default agent</option>` + agents.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join('');

  renderProjects();
  renderComposer();
  renderDetail();
  await refreshStatus();
  await refreshRuns();
  connect();
  setInterval(refreshStatus, 15_000);

  // Deep link from a notification: /?tab=inbox or /?confirm=c-xxxx
  const params = new URLSearchParams(location.search);
  if (params.get('tab') || params.get('confirm')) showView(params.get('confirm') ? 'inbox' : params.get('tab'));
}

init().catch((err) => {
  $('#health').className = 'healthline halted';
  $('#health').innerHTML = `<span class="dot"></span><span>${esc(err.message)}</span>`;
});
