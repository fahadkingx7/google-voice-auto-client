const $ = id => document.getElementById(id);
let calls = [];
let view = 'calls';
let state = {};
let leads = [], leadsLoaded = false, listBusy = false;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
const when = c => new Date(c.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const headRow = (...h) => el('thead', {}, el('tr', {}, h.map(x => el('th', { textContent: x }))));

function filtered() {
  const q = $('q').value.toLowerCase().trim();
  const f = $('f').value;
  return calls.filter(c =>
    (!f || c.disposition === f) &&
    (!q || [c.number, c.label, c.notes].join(' ').toLowerCase().includes(q))
  ).sort((a, b) => b.startedAt - a.startedAt);
}

function resultSelect(c) {
  const cls = k => 'form-select form-select-sm d-' + k;
  const sel = el('select', { className: cls(c.disposition) },
    GVL.DISPOSITIONS.filter(([k]) => GVL.AGENT_CHOICES.includes(k) || k === c.disposition).map(([k, n]) => el('option', { value: k, textContent: n, selected: k === c.disposition })));
  sel.onchange = () => {
    sel.className = cls(sel.value);
    GVL.updateCall(c.id, { disposition: sel.value, dispositionSource: 'agent' });
  };
  return sel;
}

function renderStats(rows) {
  const n = d => rows.filter(c => c.disposition === d).length;
  const items = [
    ['Calls', rows.length, '#3257F7'],
    ['Answered', n('answered'), '#198754'],
    ['Voicemail', n('voicemail'), '#7a5af8'],
    ['Talk time', GVL.fmtDur(rows.reduce((s, c) => s + (c.durationSec || 0), 0)), '#f79009']
  ];
  $('stats').replaceChildren(...items.map(([l, v, c]) =>
    el('div', { className: 'stat', style: `--c:${c}` }, el('div', { className: 'v', textContent: v }), el('div', { className: 'l', textContent: l }))));
}

function renderCalls(rows) {
  const t = $('tbl');
  t.replaceChildren(headRow('', 'When', 'Number', 'Dir', 'Length', 'Result', 'Note', ''));
  const body = el('tbody');
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 8, className: 'empty',
      textContent: calls.length ? 'No calls match your filters.' : 'No calls yet. Calls you make on Google Voice show up here automatically.' })));
  }
  for (const c of rows) {
    const note = el('input', { className: 'form-control note', value: c.notes || '', placeholder: 'Add note' });
    note.onchange = () => GVL.updateCall(c.id, { notes: note.value });
    const result = el('td', {}, resultSelect(c));
    if (c.dispositionSource === 'auto') result.append(el('span', { className: 'tag', textContent: 'auto', title: 'Auto-detected. Change it if it is wrong.' }));
    const redial = el('button', { className: 'btn btn-outline btn-redial', textContent: 'Redial', title: 'Call this number again', onclick: () => redialLead({ id: c.leadId || 'adhoc', number: c.number, name: c.label || '', company: '', notes: '' }) });
    body.append(el('tr', {},
      el('td', {}, redial),
      el('td', { className: 'nowrap', textContent: when(c) }),
      el('td', { className: 'nowrap' }, el('div', { textContent: c.number }),
        c.label && c.label !== c.number ? el('div', { className: 'sub', textContent: c.label }) : null),
      el('td', { className: 'sub', textContent: c.direction === 'incoming' ? '↙ in' : '↗ out' }),
      el('td', { className: 'nowrap' }, el('div', { textContent: GVL.fmtDur(c.durationSec) }), c.endedBy ? el('div', { className: 'sub', textContent: c.endedBy === 'agent' ? 'you hung up' : 'they ended' }) : null),
      result,
      el('td', {}, note),
      el('td', { textContent: c.dirty ? '⏳' : '✓', title: c.dirty ? 'Waiting to upload' : 'Uploaded' })));
  }
  t.append(body);
}

function renderNumbers(rows) {
  const by = new Map();
  for (const c of rows) {
    const g = by.get(c.number) || { number: c.number, label: c.label, n: 0, ans: 0, vm: 0, na: 0, dead: 0, talk: 0, last: c };
    g.n++; g.talk += c.durationSec || 0;
    if (c.disposition === 'answered') g.ans++;
    if (c.disposition === 'voicemail') g.vm++;
    if (c.disposition === 'no_answer') g.na++;
    if (c.disposition === 'dead_number') g.dead++;
    if (c.startedAt > g.last.startedAt) g.last = c;
    by.set(c.number, g);
  }
  const t = $('tbl');
  t.replaceChildren(headRow('Number', 'Calls', 'Answered', 'Voicemail', 'No answer', 'Dead', 'Talk', 'Last result'));
  const body = el('tbody');
  if (!by.size) body.append(el('tr', {}, el('td', { colSpan: 8, className: 'empty', textContent: 'Nothing to show yet.' })));
  for (const g of [...by.values()].sort((a, b) => b.last.startedAt - a.last.startedAt)) {
    body.append(el('tr', {},
      el('td', { className: 'nowrap' }, el('div', { className: g.last.disposition === 'dead_number' ? 'bad' : '', textContent: g.number }),
        g.label && g.label !== g.number ? el('div', { className: 'sub', textContent: g.label }) : null),
      ...[g.n, g.ans, g.vm, g.na].map(v => el('td', { textContent: v })),
      el('td', { className: g.dead ? 'bad' : '', textContent: g.dead }),
      el('td', { className: 'nowrap', textContent: GVL.fmtDur(g.talk) }),
      el('td', {}, el('span', { className: 'badge d-' + g.last.disposition, textContent: GVL.label(g.last.disposition) }))));
  }
  t.append(body);
}

function renderList() {
  const q = $('lq').value.toLowerCase().trim(), f = $('lf').value;
  const rows = leads.filter(l => {
    if (f === '_new') { if (l.attempts > 0) return false; }
    else if (f && l.last_disposition !== f) return false;
    return !q || [l.number, l.name, l.company, ...(l.extra || []).map(e => e.v)].join(' ').toLowerCase().includes(q);
  });
  const n = d => leads.filter(l => l.last_disposition === d).length;
  const items = [
    ['Numbers', leads.length, '#3257F7'],
    ['Not called yet', leads.filter(l => l.attempts === 0).length, '#6c757d'],
    ['Voicemail', n('voicemail'), '#7a5af8'],
    ['No answer', n('no_answer'), '#f79009']
  ];
  $('stats').replaceChildren(...items.map(([l, v, c]) =>
    el('div', { className: 'stat', style: `--c:${c}` }, el('div', { className: 'v', textContent: v }), el('div', { className: 'l', textContent: l }))));
  const t = $('tbl');
  t.replaceChildren(headRow('Contact', 'Number', 'Calls', 'Last result', 'Queue', ''));
  const body = el('tbody');
  if (!leadsLoaded) body.append(el('tr', {}, el('td', { colSpan: 6, className: 'empty', textContent: 'Loading your list…' })));
  else if (!rows.length) body.append(el('tr', {}, el('td', { colSpan: 6, className: 'empty', textContent: leads.length ? 'No numbers match this filter.' : 'No numbers on your list. Ask your admin to assign one.' })));
  for (const l of rows.slice(0, 500)) {
    const redial = el('button', { className: 'btn btn-outline btn-redial', textContent: l.attempts ? 'Redial' : 'Call', onclick: () => redialLead(l) });
    body.append(el('tr', {},
      el('td', {}, el('div', { textContent: l.name || l.company || '—' }), l.name && l.company ? el('div', { className: 'sub', textContent: l.company }) : null,
        Array.isArray(l.extra) && l.extra.length ? el('div', { className: 'sub', title: l.extra.map(e => e.l + ': ' + e.v).join('\n'), textContent: l.extra.slice(0, 3).map(e => e.l + ': ' + e.v).join(' · ') }) : null),
      el('td', { className: 'nowrap', textContent: l.number }),
      el('td', { className: 'nowrap', textContent: l.attempts || 0 }),
      el('td', {}, l.last_disposition ? el('span', { className: 'badge d-' + l.last_disposition, textContent: GVL.label(l.last_disposition) }) : el('span', { className: 'sub', textContent: 'not called' })),
      el('td', { className: 'st-pill', textContent: l.status === 'pending' ? 'in queue' : l.status === 'skipped' ? 'skipped' : 'done' }),
      el('td', {}, redial)));
  }
  if (rows.length > 500) body.append(el('tr', {}, el('td', { colSpan: 6, className: 'empty', textContent: `Showing the first 500 of ${rows.length}. Use the filter or search to narrow it down.` })));
  t.append(body);
}

function render() {
  if (view === 'list') return renderList();
  const rows = filtered();
  renderStats(rows);
  view === 'calls' ? renderCalls(rows) : renderNumbers(rows);
}

function renderSync() {
  const pending = calls.filter(c => c.dirty).length;
  const b = $('sync');
  if (state.syncError) { b.className = 'badge err'; b.textContent = '⚠ ' + state.syncError; }
  else if (pending) { b.className = 'badge warn'; b.textContent = `⏳ ${pending} waiting to upload`; }
  else { b.className = 'badge ok'; b.textContent = '✓ All synced' + (state.lastSync ? ' · ' + new Date(state.lastSync).toLocaleTimeString([], { timeStyle: 'short' }) : ''); }
}

async function load() {
  state = await chrome.storage.local.get(['calls', 'session', 'syncError', 'lastSync']);
  calls = state.calls || [];
  $('login').hidden = !!state.session;
  $('main').hidden = !state.session;
  if (state.session) {
    $('who').textContent = state.session.user.email;
    renderSync();
    render();
  }
}

function send(msg) {
  return new Promise(res => chrome.runtime.sendMessage(msg, r => res(r || { ok: false, error: chrome.runtime.lastError?.message })));
}

// "Your dial list" card: progress through the numbers the admin assigned.
async function loadQueue() {
  const box = $('queue');
  const open = el('button', { className: 'btn btn-primary btn-sm', textContent: 'Open Google Voice', onclick: () => chrome.tabs.create({ url: 'https://voice.google.com/' }) });
  const refresh = el('button', { className: 'btn btn-outline btn-sm', textContent: '↻ Refresh', title: 'Check for new numbers' });
  refresh.onclick = async () => { refresh.disabled = true; refresh.textContent = 'Checking…'; try { await send({ type: 'sync' }); await loadQueue(); } finally { refresh.disabled = false; refresh.textContent = '↻ Refresh'; } };
  let d = null, err = '';
  try { const r = await send({ type: 'queue' }); d = r.ok ? r.data : null; err = r.error || ''; } catch (e) { err = String(e.message || e); }
  const total = d ? d.pending + d.called : 0;
  // Always show the card, so the popup never looks empty and Open Google Voice is never missing.
  const note = !d ? "Couldn't load your dial list" + (err ? ': ' + err : '.')
    : total === 0 ? 'No leads yet. Your admin has not assigned any, or the list is disabled. Tap Refresh to check again.'
    : `${d.called} of ${total} called · ${d.pending} to go`;
  box.replaceChildren(
    el('div', { className: 'q-row' },
      el('div', {}, el('div', { className: 'q-title', textContent: 'Your dial list' }), el('div', { className: 'muted', textContent: note })),
      el('div', { style: 'display:flex;gap:8px;flex:none' }, refresh, open)),
    total ? el('div', { className: 'progress' }, el('div', { className: 'progress-bar', style: `width:${Math.round(d.called / total * 100)}%` })) : null);
  box.hidden = false;
}

function say(text, ms = 5000) {
  const m = $('listmsg'); m.textContent = text; m.hidden = !text;
  if (text) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, ms);
}
async function loadLeads() {
  const r = await send({ type: 'myLeads' });
  if (r.ok) { leads = r.data; leadsLoaded = true; } else say(r.error || 'Could not load your list.', 8000);
  if (view === 'list') render();
}
async function redialLead(l) {
  const lead = { id: l.id, number: l.number, name: l.name, company: l.company, notes: l.notes, extra: l.extra || [] };
  const tabs = await chrome.tabs.query({ url: 'https://voice.google.com/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    try { await chrome.windows.update(tabs[0].windowId, { focused: true }); } catch (e) { /* ignore */ }
    try { await chrome.tabs.sendMessage(tabs[0].id, { type: 'dialLead', lead }); }
    catch (e) { say('Reload your Google Voice tab, then try again.'); return; }
  } else {
    await chrome.storage.local.set({ dialRequest: { lead, ts: Date.now() } });
    await chrome.tabs.create({ url: 'https://voice.google.com/u/0/calls' });
  }
  window.close();
}
async function requeueShown() {
  const q = $('lq').value.toLowerCase().trim(), f = $('lf').value;
  const rows = leads.filter(l => (f === '_new' ? l.attempts === 0 : (!f || l.last_disposition === f)) &&
    (!q || [l.number, l.name, l.company, ...(l.extra || []).map(e => e.v)].join(' ').toLowerCase().includes(q)) && l.status !== 'pending');
  if (!rows.length) return say('Everything shown is already in your queue.');
  if (!confirm(`Put ${rows.length} number(s) back in your auto-dial queue?`)) return;
  const r = await send({ type: 'requeue', ids: rows.map(l => l.id) });
  say(r.ok ? `${rows.length} number(s) are back in your queue.` : (r.error || 'Could not re-queue.'), 7000);
  await loadLeads(); loadQueue();
}

function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
const csvCell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';

(function init() {
  $('logo').src = BRAND.logo;
  $('logo2').src = BRAND.logo;
  $('f').append(el('option', { value: '', textContent: 'All results' }), ...GVL.DISPOSITIONS.map(([k, n]) => el('option', { value: k, textContent: n })));
  $('q').oninput = render;
  $('f').onchange = render;
  $('lf').append(el('option', { value: '', textContent: 'All numbers' }), el('option', { value: '_new', textContent: 'Not called yet' }),
    ...GVL.DISPOSITIONS.map(([k, n]) => el('option', { value: k, textContent: 'Last result: ' + n })));
  $('lq').oninput = render; $('lf').onchange = render; $('lrq').onclick = requeueShown;
  const setTab = v => {
    view = v;
    for (const k of ['calls', 'numbers', 'list']) $('tab-' + k).className = v === k ? 'active' : '';
    $('bar-calls').hidden = v === 'list'; $('bar-list').hidden = v !== 'list';
    if (v !== 'list') $('listmsg').hidden = true;
    render();
    if (v === 'list') loadLeads();
  };
  $('tab-calls').onclick = () => setTab('calls');
  $('tab-numbers').onclick = () => setTab('numbers');
  $('tab-list').onclick = () => setTab('list');

  const doLogin = async () => {
    $('err').hidden = true;
    $('go').disabled = true;
    const r = await send({ type: 'login', email: $('em').value.trim(), password: $('pw').value });
    $('go').disabled = false;
    if (!r.ok) { $('err').textContent = r.error || 'Sign-in failed'; $('err').hidden = false; }
    else { $('pw').value = ''; await load(); loadQueue(); }
  };
  $('go').onclick = doLogin;
  $('pw').onkeydown = e => { if (e.key === 'Enter') doLogin(); };

  $('out').onclick = async () => {
    const r = await send({ type: 'logout' });
    if (!r.ok) alert(r.error || 'Could not sign out');
    await load();
  };
  $('syncnow').onclick = async () => { await send({ type: 'sync' }); await load(); };

  $('csv').onclick = () => {
    const cols = ['number', 'label', 'direction', 'startedAt', 'endedAt', 'durationSec', 'autoDisposition', 'disposition', 'dispositionSource', 'notes'];
    const lines = [cols.join(',')];
    for (const c of filtered()) lines.push(cols.map(k => csvCell(k === 'startedAt' || k === 'endedAt' ? new Date(c[k]).toISOString() : c[k])).join(','));
    download('my-calls.csv', lines.join('\n'), 'text/csv');
  };

  chrome.storage.onChanged.addListener(() => {
    const a = document.activeElement;
    if (!a || !['INPUT', 'SELECT'].includes(a.tagName)) load();
  });
  load().then(() => { if (state.session) loadQueue(); });
  setInterval(() => { if (state.session) loadQueue(); }, 30000);
})();
