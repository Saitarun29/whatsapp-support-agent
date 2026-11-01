// WhatsApp Support Agent · client
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REQUEST_TIMEOUT_MS = 20000;
const MIN_TYPING_MS = 450;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inr = (n) => '₹' + Number(n).toLocaleString('en-IN');
const clock = () => new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const TICKS = '<svg class="ticks" viewBox="0 0 16 10" aria-hidden="true"><path d="M1 5.5l3 3L10 1.5M6 8.5l1 0L14 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const OUTCOME = {
  answered: ['Answered', 'ok'],
  needs_info: ['Asked a follow-up', 'ok'],
  handoff: ['Handed off', 'warn'],
  refused: ['Refused', 'warn'],
  blocked: ['Blocked', 'bad'],
};
const LANG = { en: 'English', hinglish: 'Hinglish', hi: 'Hindi' };
const STATUS_LABEL = { pass: 'Pass', info: 'Info', escalate: 'Escalate', refuse: 'Refuse', block: 'Block' };

// ---------- state ----------
let data = null;          // { limits, businesses }
let biz = null;           // current business
let busy = false;
const convos = {};        // per business: { items, turns, state, chips, selected }
const stats = { messages: 0, answered: 0, handoff: 0, refused: 0 };

const convo = () => {
  if (!convos[biz.id]) convos[biz.id] = freshConvo();
  return convos[biz.id];
};
function freshConvo() {
  return {
    items: [{ kind: 'in', text: biz.greeting.en, time: clock() }],
    turns: [], state: {}, chips: biz.chips, selected: null,
  };
}

// ---------- boot ----------
async function boot() {
  fetch('/api/status').then((r) => r.json()).then((s) => {
    const b = $('#modeBadge');
    b.textContent = s.mode === 'live' ? 'Live' : 'Demo';
    b.className = 'badge ' + (s.mode === 'live' ? 'ok' : '');
    b.title = s.mode === 'live' ? `Live: ${s.model} classifies and phrases FAQ answers; guardrails still decide` : 'Demo: deterministic classifier and KB templates, same JSON contract as live';
  }).catch(() => { $('#modeBadge').textContent = 'Offline'; $('#modeBadge').className = 'badge bad'; });

  try {
    const r = await fetch('/api/businesses');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    $('#bizTabs').innerHTML = '<span class="seg-skel">Could not load businesses.</span>';
    showError('Could not reach the API. Run the app with `npm run dev` or `vercel dev`, not by opening index.html directly.');
    setBusy(true);
    return;
  }
  $('#factFloor').textContent = data.limits.confidence_floor.toFixed(2);
  const fromHash = data.businesses.find((b) => '#' + b.id === location.hash);
  selectBusiness((fromHash || data.businesses[0]).id);
}

// ---------- business selector ----------
function renderTabs() {
  $('#bizTabs').innerHTML = data.businesses.map((b) => `
    <button type="button" class="seg-btn" role="radio" aria-checked="${b.id === biz.id}" tabindex="${b.id === biz.id ? 0 : -1}" data-id="${b.id}">
      <span class="avatar" aria-hidden="true">${esc(b.initials)}</span>
      <span><b>${esc(b.name)}</b><small>${esc(b.kind)} · ${esc(b.city)}</small></span>
    </button>`).join('');
}
$('#bizTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (b && !busy) selectBusiness(b.dataset.id);
});
$('#bizTabs').addEventListener('keydown', (e) => {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key) || busy) return;
  e.preventDefault();
  const ids = data.businesses.map((b) => b.id);
  const i = ids.indexOf(biz.id) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
  selectBusiness(ids[(i + ids.length) % ids.length]);
  $(`.seg-btn[data-id="${biz.id}"]`).focus();
});

function selectBusiness(id) {
  biz = data.businesses.find((b) => b.id === id);
  history.replaceState(null, '', '#' + id);
  renderTabs();
  $('#factLimit').textContent = inr(biz.refund_auto_limit);
  $('#bizAvatar').textContent = biz.initials;
  $('#bizName').textContent = biz.name;
  $('#bizStatus').textContent = 'Business account';
  $('#custName').textContent = biz.customer.name;
  $('#custPhone').textContent = biz.customer.phone;
  renderScenarios();
  renderChat();
  const c = convo();
  renderTrace(c.selected != null ? c.turns[c.selected] : null);
  renderData();
  showError('');
}

// ---------- scenarios ----------
function tone(tag) { return /^(Handoff)/.test(tag) ? 'warn' : /^(Refused|Blocked)/.test(tag) ? 'bad' : 'ok'; }
function renderScenarios() {
  $('#scenarios').innerHTML = biz.scenarios.map((s, i) => `
    <li><button type="button" class="scen" data-i="${i}"><span>${esc(s.label)}</span><small class="${tone(s.tag)}">${esc(s.tag)}</small></button></li>`).join('');
}
$('#scenarios').addEventListener('click', (e) => {
  const b = e.target.closest('.scen');
  if (b) send(biz.scenarios[Number(b.dataset.i)].label);
});

// ---------- chat ----------
function renderChat() {
  const c = convo();
  const log = $('#chatLog');
  log.innerHTML = '<span class="day">Today</span>' + c.items.map((m) => {
    if (m.kind === 'sys') return `<div class="sys ${m.tone || ''}">${m.html}</div>`;
    if (m.kind === 'typing') return '<div class="typing" aria-label="Agent is typing"><i></i><i></i><i></i></div>';
    const foot = m.kind === 'out'
      ? `<span>${esc(m.time)}</span>${m.failed ? '<span>Not delivered</span>' : TICKS}`
      : `${m.turn != null ? `<button type="button" class="trace-link" data-turn="${m.turn}" aria-current="${c.selected === m.turn}" aria-label="Show trace for this reply">Trace</button>` : ''}<span>${esc(m.time)}</span>`;
    return `<div class="msg ${m.kind}${m.read ? ' read' : ''}">${esc(m.text)}<div class="msg-foot">${foot}</div></div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
  $('#chips').innerHTML = (c.chips || []).map((ch) => `<button type="button" class="chip" data-id="${esc(ch.id)}" title="${esc(ch.title)}">${esc(ch.title)}</button>`).join('');
  setBusy(busy);
}
$('#chatLog').addEventListener('click', (e) => {
  const b = e.target.closest('.trace-link');
  if (!b) return;
  const c = convo();
  c.selected = Number(b.dataset.turn);
  renderTrace(c.turns[c.selected]);
  renderChat();
});
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  const ch = convo().chips.find((x) => x.id === b.dataset.id);
  if (ch) send(ch.title, ch.id);
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msg').value.trim();
  if (!v) { $('#msg').focus(); return; }
  send(v);
});
$('#clearChat').addEventListener('click', () => {
  if (busy) return;
  convos[biz.id] = freshConvo();
  renderChat();
  renderTrace(null);
  showError('');
});

function setBusy(v) {
  busy = v;
  document.querySelectorAll('.chip, .scen, #sendBtn, .seg-btn, #clearChat').forEach((el) => { el.disabled = v; });
  $('#bizStatus').textContent = v ? 'typing…' : 'Business account';
}

async function send(text, replyId = null) {
  if (busy || !biz) return;
  const c = convo();
  const out = { kind: 'out', text, time: clock() };
  c.items.push(out);
  c.chips = [];
  c.items.push({ kind: 'typing' });
  $('#msg').value = '';
  setBusy(true);
  renderChat();
  $('#traceMeta').textContent = 'Running…';
  showError('');
  stats.messages++;

  const t0 = performance.now();
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business: biz.id, message: text, reply_id: replyId, state: c.state }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    res = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(res.error || `HTTP ${r.status}`);
  } catch (e) {
    c.items = c.items.filter((m) => m.kind !== 'typing');
    out.failed = true;
    c.chips = biz.chips;
    setBusy(false);
    renderChat();
    $('#traceMeta').textContent = 'Error';
    showError(e.name === 'AbortError' ? 'The agent took too long to answer. Nothing was sent to the customer.' : `Message not processed: ${e.message}`);
    return;
  }
  const wait = MIN_TYPING_MS - (performance.now() - t0);
  if (wait > 0 && !reduced) await sleep(wait);

  c.items = c.items.filter((m) => m.kind !== 'typing');
  out.read = true;
  const turn = c.turns.push(res) - 1;
  c.items.push({ kind: 'in', text: res.reply.text, time: clock(), turn });
  if (res.handoff) {
    c.items.push({ kind: 'sys', tone: 'warn', html: `<b>Handed off</b> · ticket ${esc(res.handoff.id)} in ${esc(res.handoff.queue)} · bot paused in production. The demo keeps the bot on so you can keep testing.` });
  }
  if (res.booking) c.items.push({ kind: 'sys', tone: 'ok', html: `<b>Booked</b> · ${esc(res.booking.id)} · ${esc(res.booking.label)}` });
  if (res.refund?.refund_id) c.items.push({ kind: 'sys', tone: 'ok', html: `<b>Refund initiated</b> · ${esc(res.refund.refund_id)} · ${inr(res.refund.amount)}` });
  c.state = res.state || {};
  c.chips = res.chips && res.chips.length ? res.chips : (res.outcome === 'handoff' ? [] : biz.chips);
  c.selected = turn;

  if (res.outcome === 'handoff') stats.handoff++;
  else if (res.outcome === 'refused' || res.outcome === 'blocked') stats.refused++;
  else stats.answered++;

  setBusy(false);
  renderChat();
  renderTrace(res);
  renderSession();
}

function showError(msg) { const b = $('#errorBox'); b.hidden = !msg; b.textContent = msg || ''; }

// ---------- trace ----------
function renderTrace(t) {
  const box = $('#trace');
  if (!t) {
    $('#traceMeta').textContent = 'Idle';
    box.innerHTML = '<p class="empty">Send a message or pick a scenario. Intent, confidence, tool calls and guardrail decisions for each reply appear here.</p>';
    return;
  }
  const c = convo();
  $('#traceMeta').textContent = `Turn ${c.turns.indexOf(t) + 1} · ${t.mode === 'live' ? 'Live · ' + t.model : 'Demo'} · ${t.latency_ms} ms`;
  const [oLabel, oTone] = OUTCOME[t.outcome] || [t.outcome, ''];
  const conf = typeof t.confidence === 'number' ? t.confidence.toFixed(2) : 'n/a';
  const floor = data.limits.confidence_floor;
  const confTone = typeof t.confidence === 'number' && t.confidence < floor ? 'warn' : '';

  const probs = t.probs ? Object.entries(t.probs).sort((a, b) => b[1] - a[1]) : [];
  const bars = probs.length ? `
    <div class="sec">
      <h3>Intent probabilities</h3>
      <div class="bars">${probs.map(([k, p]) => `<div class="bar${k === t.intent ? ' top' : ''}"><span>${esc(k)}</span><i style="--w:${Math.round(p * 100)}%" role="img" aria-label="${esc(k)} ${p.toFixed(2)}"></i><em>${p.toFixed(2)}</em></div>`).join('')}</div>
      <p class="floor-note">Floor ${floor.toFixed(2)}. Below it the agent hands off instead of guessing.${t.signals && t.signals.length ? ' Rule signals:' : ''}</p>
      ${t.signals && t.signals.length ? `<div class="signals">${t.signals.slice(0, 8).map((s) => `<code>${esc(s)}</code>`).join('')}</div>` : ''}
    </div>` : '';

  const steps = `
    <div class="sec">
      <h3>Pipeline</h3>
      <ol class="steps">${t.trace.map((s) => `
        <li class="stp">
          <span class="stage">${esc(s.stage)}</span>
          <div><b>${esc(s.name)}</b><p>${esc(s.detail)}</p>${s.args || s.result ? `<details><summary>Arguments and result</summary><pre>${esc(JSON.stringify({ args: s.args, result: s.result }, null, 2))}</pre></details>` : ''}</div>
          <span class="st ${esc(s.status)}">${STATUS_LABEL[s.status] || esc(s.status)}</span>
        </li>`).join('')}
      </ol>
    </div>`;

  const ticket = t.handoff ? `
    <div class="sec">
      <h3>Handoff ticket</h3>
      <div class="ticket">
        <div class="ticket-bar"><span><b>${esc(t.handoff.queue)}</b> · Slack</span><span>${esc(t.handoff.id)}</span></div>
        <div class="ticket-body">
          <div class="ticket-title">${esc(t.handoff.reason)} <span class="badge ${t.handoff.priority === 'high' ? 'bad' : 'warn'}">${esc(t.handoff.priority)} priority</span></div>
          <dl class="kv">
            <dt>Customer</dt><dd>${esc(t.handoff.customer)}</dd>
            <dt>Last message</dt><dd>${esc(t.handoff.last_message)}</dd>
            <dt>Reason code</dt><dd class="mono">${esc(t.handoff.reason_code)}</dd>
            <dt>Intent</dt><dd>${esc(t.handoff.intent)} · ${typeof t.handoff.confidence === 'number' ? t.handoff.confidence.toFixed(2) : 'n/a'} · ${esc(LANG[t.handoff.language] || t.handoff.language)}</dd>
            <dt>Reply within</dt><dd>${esc(t.handoff.sla)}</dd>
          </dl>
          <div class="ticket-actions"><span class="btn btn-sm" aria-disabled="true">Take over chat</span><span class="btn btn-sm" aria-disabled="true">Resume bot</span></div>
        </div>
      </div>
    </div>` : '';

  const reply = `
    <div class="sec">
      <h3>Reply sent</h3>
      <div class="reply-box">${esc(t.reply.text)}</div>
      <p class="reply-meta">${esc(LANG[t.reply.lang] || t.reply.lang)}${t.sources ? ` · from KB: ${t.sources.map(esc).join(', ')}` : ''}${t.chips && t.chips.length ? ` · ${t.chips.length} quick replies` : ''}${t.fallback ? ` · ${esc(t.fallback)}` : ''}</p>
    </div>`;

  box.innerHTML = `
    <div class="sum">
      <div><small>Intent</small><b>${esc(t.intent)}</b></div>
      <div><small>Confidence</small><b class="${confTone}">${conf}</b></div>
      <div><small>Language</small><b>${esc(LANG[t.lang?.code] || 'n/a')}</b></div>
      <div><small>Outcome</small><b class="${oTone}">${esc(oLabel)}</b></div>
    </div>${bars}${steps}${ticket}${reply}`;
}

// ---------- data tabs ----------
function renderData() {
  $('#pane-kb').innerHTML = `<div class="kb-list">${biz.kb.map((k) => `<article class="kb-item"><h3>${esc(k.title)} <code>${esc(k.id)}</code></h3><p>${esc(k.en)}</p></article>`).join('')}</div>
    <p class="pane-note">Every FAQ answer must come from one of these entries (match score ≥ ${data.limits.kb_min_score}). Each entry also has a Hinglish version.</p>`;
  $('#pane-rec').innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th scope="col">${esc(biz.record_label)}</th><th scope="col">Items</th><th scope="col" class="r">Amount</th><th scope="col">Status</th><th scope="col">When</th><th scope="col">Phone</th></tr></thead>
      <tbody>${biz.records.map((r) => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.items)}</td><td class="r">${inr(r.amount)}</td><td><span class="tag ${r.status === 'cancelled' ? 'warn' : ['delivered', 'completed', 'confirmed', 'active'].includes(r.status) ? 'ok' : ''}">${esc(r.status.replace(/_/g, ' '))}</span></td><td>${esc(r.when)}</td><td>${esc(r.owner)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="pane-note">Mock back office. Refunds up to ${inr(biz.refund_auto_limit)} are automatic within policy; anything larger goes to a person. Records on another customer's number are never shown.</p>`;
  renderSession();
}
function renderSession() {
  $('#pane-ses').innerHTML = `
    <div class="session">
      <div><small>Customer messages</small><b>${stats.messages}</b></div>
      <div><small>Resolved by agent</small><b>${stats.answered}</b></div>
      <div><small>Handed to a person</small><b>${stats.handoff}</b></div>
      <div><small>Refused or blocked</small><b>${stats.refused}</b></div>
    </div>
    <div class="impact">
      <h3>Business impact <span class="badge plain">Estimated, not measured</span></h3>
      <p>Assume a business gets 1,500 WhatsApp chats a month and 60% are FAQ, order status or booking questions (a typical range is 50 to 70%). At about 3 minutes of staff time each, automating them saves roughly 45 staff hours a month, and customers get answers outside business hours.</p>
      <p class="small">These are planning assumptions for illustration. The counts above are from this browser session only.</p>
    </div>`;
}

const tabs = [...document.querySelectorAll('.tab')];
function selectTab(tab) {
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  });
}
tabs.forEach((t) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const n = tabs[(tabs.indexOf(t) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    selectTab(n);
    n.focus();
  });
});

boot();
