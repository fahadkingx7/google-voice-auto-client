// Floating auto-dialer (TrucksMate). Shows the agent's assigned numbers and dials them via Google Voice.
// Talks to background.js for the queue; to content.js through GVL.hooks / GVL.state / GVL.actions.
(() => {
  if (window.__gvlDialerLoaded) return;
  window.__gvlDialerLoaded = true;

  const AUTO_NEXT_SEC = typeof CFG.AUTO_NEXT_SEC === 'number' ? CFG.AUTO_NEXT_SEC : 8;
  const SCALE = typeof CFG.DIAL_WAIT_SCALE === 'number' ? CFG.DIAL_WAIT_SCALE : 1; // tests shrink the waits
  const DIAL_TIMEOUT_MS = 25000;

  // ---- Tunables: how we find things on Google Voice's page ----
  const FIELD_SEL = 'input[aria-label*="name or number" i],input[placeholder*="name or number" i],input[aria-label*="enter a name" i],input[aria-label*="phone number" i],input[type="tel"]';
  const OPEN_DIALER_RE = /make a call|new call|call someone|dial ?pad|keypad/i;
  const CALL_LABEL_RE = /^(call|start call|place call|make call|make a call)(\s|$)/i;
  const CALL_ROW_RE = /^call\s+\+?[\d(]/i;
  const NOT_RE = /history|setting|forward|block|spam|report|log ?out|\bend\b|hang/i;

  const tabId = (() => {
    let t = sessionStorage.getItem('gvl_tab');
    if (!t) { t = GVL.uid(); sessionStorage.setItem('gvl_tab', t); }
    return t;
  })();

  const DEFAULT = { mode: 'idle', phase: 'idle', lead: null, owner: null, since: 0, msg: '', lastRec: null, minimized: false, awaiting: false };
  let D = { ...DEFAULT };
  let Q = { next: null, pending: 0, called: 0, loaded: false };
  let signedIn = false;
  let countdown = null;
  let held = false;
  let host = null, shadow = null, body = null, chipEl = null;

  const mine = () => D.owner === tabId;
  const live = () => !!GVL.state.call || D.phase === 'dialing' || D.phase === 'incall';

  async function setD(patch) {
    D = { ...D, ...patch };
    await chrome.storage.local.set({ dialer: D });
  }
  const bg = msg => new Promise(res => {
    try { chrome.runtime.sendMessage(msg, r => res(r || { ok: false, error: chrome.runtime.lastError?.message })); }
    catch (e) { res({ ok: false, error: String(e) }); }
  });
  async function refreshQueue() {
    const r = await bg({ type: 'queue' });
    if (r.ok) Q = { ...r.data, loaded: true };
    render();
    return r;
  }

  // ---------- driving Google Voice's own UI (no page reload) ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms * SCALE));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ownLabel = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || el.getAttribute('mattooltip') || (el.textContent || '').trim()).trim();
  const clickables = () => [...document.querySelectorAll('button,[role="button"],a')].filter(visible);
  const findField = () => [...document.querySelectorAll(FIELD_SEL)].find(visible) || null;

  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup'])
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  function clickMatching(test) {
    for (const b of clickables()) {
      const l = ownLabel(b);
      if (NOT_RE.test(l) || !test(l)) continue;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      b.click();
      return true;
    }
    return false;
  }
  const clickCall = () => clickMatching(l => CALL_LABEL_RE.test(l) || CALL_ROW_RE.test(l));

  // Type the number into Google Voice's dial box and press Call, without leaving the page.
  async function dialInPage(number, since) {
    const stopped = () => D.phase !== 'dialing' || D.since !== since;
    const started = () => !!GVL.state.call;
    if (!/\/calls/.test(location.pathname)) {
      const nav = [...document.querySelectorAll('a[href*="/calls"]')].find(visible);
      if (nav) { nav.click(); await sleep(1200); }
    }
    let field = findField();
    if (!field) {
      clickMatching(l => OPEN_DIALER_RE.test(l));
      for (let i = 0; i < 10 && !field && !stopped(); i++) { await sleep(300); field = findField(); }
    }
    if (stopped() || !field) return false;
    setValue(field, number);
    await sleep(600);
    if (started() || stopped()) return started();
    pressEnter(field);
    await sleep(1500);
    for (let i = 0; i < 4 && !started() && !stopped(); i++) {
      if (clickCall()) await sleep(1500); else await sleep(500);
    }
    return started();
  }

  // ---------- fallback: Google's dial link (reloads the page) ----------
  function dialUrl(number) {
    const m = location.pathname.match(/^\/u\/(\d+)\//);
    return `https://voice.google.com${m ? '/u/' + m[1] : '/u/0'}/calls?a=nc,${encodeURIComponent(number)}`;
  }
  function watchDial() {
    const started = D.since;
    let clicks = 0, lastClick = 0;
    const iv = setInterval(async () => {
      if (D.phase !== 'dialing' || D.since !== started) return clearInterval(iv);
      if (GVL.state.call) return clearInterval(iv);
      const age = Date.now() - started;
      if (age > 3500 && clicks < 3 && Date.now() - lastClick > 4000 && clickCall()) { clicks++; lastClick = Date.now(); }
      if (age > DIAL_TIMEOUT_MS) { clearInterval(iv); await dialFailed(); }
    }, 500);
  }

  // Safe on purpose: never auto-skip or auto-fail a lead, or one broken selector would burn the whole list.
  async function dialFailed() {
    await setD({ phase: 'idle', mode: 'paused', awaiting: true, since: Date.now(),
      msg: `Couldn't start the call to ${D.lead?.number || 'this number'} automatically. Click Call in Google Voice yourself (it is still logged to this number), or press Dial next to retry.` });
    render();
  }

  async function dialNext() {
    if (GVL.state.call) return;
    cancelCountdown();
    const r = await bg({ type: 'queue' });
    if (!r.ok) { await setD({ msg: 'Could not reach the server: ' + (r.error || 'offline?') }); return render(); }
    Q = { ...r.data, loaded: true };
    if (!Q.next) { await setD({ mode: 'idle', phase: 'idle', lead: null, msg: '', awaiting: false }); return render(); }
    await beginDial(Q.next);
  }

  // Redial from "My list": dials exactly this number, then waits (no auto chain).
  async function dialLead(lead) {
    if (!signedIn || !lead || !lead.number) return;
    if (live()) { await setD({ msg: 'Finish or hang up the current call first.' }); return render(); }
    cancelCountdown();
    await setD({ mode: 'paused', minimized: false });
    await beginDial({ id: lead.id, number: lead.number, name: lead.name || '', company: lead.company || '', notes: lead.notes || '' });
  }

  async function beginDial(target) {
    await setD({ owner: tabId, phase: 'dialing', lead: target, since: Date.now(), msg: '', lastRec: null, awaiting: false });
    render();
    const since = D.since, lead = D.lead;
    const ok = await dialInPage(lead.number, since);
    if (ok || GVL.state.call || D.phase !== 'dialing' || D.since !== since) return;
    if (CFG.DIAL_FALLBACK_RELOAD !== false) { location.assign(dialUrl(lead.number)); return; }
    await dialFailed();
  }

  // ---------- controls ----------
  async function startAuto() {
    if (!Q.next && !live()) { await setD({ msg: 'No numbers assigned to you yet.' }); return render(); }
    await setD({ mode: 'running', owner: tabId, msg: '' });
    if (!live() && D.phase !== 'wrapup') dialNext();
    else if (D.phase === 'wrapup') { startCountdown(); render(); }
    else render();
  }
  async function pause() {
    cancelCountdown();
    await setD({ mode: 'paused', msg: '' });
    render();
  }
  async function hangUp() {
    if (GVL.state.call) {
      if (!GVL.actions.endCall()) { await setD({ msg: "Couldn't find Google Voice's End call button. Hang up in Google Voice." }); render(); }
      return;
    }
    await setD({ phase: 'idle', mode: 'paused', msg: '', awaiting: false });
    GVL.actions.endCall();
    render();
  }
  async function skipNext() {
    if (!Q.next) return;
    const r = await bg({ type: 'leadSkip', id: Q.next.id });
    if (!r.ok) await setD({ msg: r.error || 'Could not skip that number.' });
    await setD({ awaiting: false });
    await refreshQueue();
  }
  async function copyDebug(btnEl) {
    const text = GVL.actions.debug();
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    btnEl.textContent = 'Copied. Paste it to your developer.';
  }

  // ---------- countdown between auto calls ----------
  function cancelCountdown() {
    if (countdown) { clearTimeout(countdown.timer); countdown = null; }
  }
  function startCountdown(sec = AUTO_NEXT_SEC) {
    cancelCountdown();
    const ms = sec * 1000;
    countdown = {
      ms, endsAt: Date.now() + ms,
      timer: setTimeout(() => {
        countdown = null;
        if (D.mode === 'running' && mine() && D.phase === 'wrapup') dialNext();
      }, ms)
    };
  }

  // ---------- hooks called by content.js ----------
  GVL.hooks.onCallStart = () => {
    const linkable = D.lead && (D.phase === 'dialing' || (D.awaiting && Date.now() - D.since < 120000));
    if (!linkable) return null;
    GVL.state.leadNumber = D.lead.number;
    GVL.state.leadLabel = [D.lead.name, D.lead.company].filter(Boolean).join(' · ');
    setD({ phase: 'incall', since: Date.now(), awaiting: false, msg: '' }).then(render);
    return D.lead.id;
  };

  GVL.hooks.onCallRecorded = rec => {
    if (!rec.leadId) return false;
    setD({ phase: 'wrapup', since: Date.now(), lastRec: { id: rec.id, disposition: rec.disposition, durationSec: rec.durationSec, auto: true } }).then(render);
    (async () => {
      const done = await bg({ type: 'leadDone', id: rec.leadId });
      if (!done.ok) {
        await setD({ mode: 'paused', msg: "Couldn't update your list (" + (done.error || 'offline') + '). Check your connection, then press Dial next.' });
        return render();
      }
      await refreshQueue();
      if (D.mode === 'running' && mine() && D.phase === 'wrapup' && !held) { startCountdown(); render(); }
    })();
    return true;
  };

  async function setDisposition(k, note) {
    const id = D.lastRec?.id;
    if (!id) return;
    await GVL.updateCall(id, { disposition: k, dispositionSource: 'agent', ...(note ? { notes: note } : {}) });
    await setD({ lastRec: { ...D.lastRec, disposition: k, auto: false } });
    if (D.mode === 'running' && mine()) { cancelCountdown(); dialNext(); } else render();
  }

  // ---------- widget ----------
  const COLORS = {
    answered: ['#0f5132', '#d1e7dd'], voicemail: ['#5925dc', '#e5dcfb'], no_answer: ['#495057', '#e9ecef'],
    busy: ['#664d03', '#fff3cd'], dead_number: ['#842029', '#f8d7da'], wrong_number: ['#984c0c', '#ffe5d0'],
    do_not_call: ['#58151c', '#f5c2c7'], other: ['#343a40', '#f1f3f5']
  };
  const GRID = ['answered', 'voicemail', 'no_answer', 'busy', 'dead_number', 'wrong_number', 'do_not_call', 'other'];

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
    .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; color: #212529; font-size: 14px; line-height: 1.45; }
    .card { width: 360px; background: #fff; border: 1px solid #dee2e6; border-radius: 14px; box-shadow: 0 .75rem 2rem rgba(33,37,41,.22); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #fff; border-bottom: 1px solid #e9ecef; }
    .head img { height: 24px; display: block; }
    .head .t { font-weight: 600; font-size: 15px; }
    .head .sp { flex: 1; }
    .head .cnt { font-size: 12px; font-weight: 600; color: #3257F7; background: #eef2ff; padding: 3px 10px; border-radius: 999px; }
    .iconbtn { border: none; background: none; cursor: pointer; font-size: 20px; color: #6c757d; line-height: 1; padding: 0 6px; border-radius: 6px; }
    .iconbtn:hover { background: #f1f3f5; color: #212529; }
    .prog { height: 6px; background: #e9ecef; }
    .prog i { display: block; height: 100%; background: linear-gradient(90deg, #3257F7, #6d8bff); transition: width .4s; }
    .main { padding: 16px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; }
    .chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .chip.slate { background: #e9ecef; color: #495057; } .chip.blue { background: #eef2ff; color: #3257F7; }
    .chip.green { background: #d1e7dd; color: #0f5132; } .chip.amber { background: #fff3cd; color: #664d03; }
    .chip.amber::before, .chip.green::before { animation: pulse 1.2s infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .lead { display: flex; gap: 12px; align-items: center; margin: 12px 0 8px; padding: 12px; border: 1px solid #e9ecef; border-radius: 12px; background: #f8f9fa; }
    .av { width: 44px; height: 44px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 15px; background: linear-gradient(135deg, #3257F7, #7a5af8); }
    .lead .n { font-size: 15px; font-weight: 600; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 235px; }
    .lead .c { color: #6c757d; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 235px; }
    .lead .p { font-size: 15px; font-weight: 600; color: #3257F7; font-variant-numeric: tabular-nums; }
    .notes { background: #fff; border: 1px solid #e9ecef; border-radius: 10px; padding: 8px 10px; font-size: 12.5px; color: #495057; margin: 8px 0; max-height: 64px; overflow: auto; }
    .alert { background: #fff3cd; border: 1px solid #ffe69c; color: #664d03; border-radius: 10px; padding: 9px 12px; font-size: 13px; margin: 12px 0 0; }
    .hint { color: #6c757d; font-size: 12.5px; margin: 10px 0 0; text-align: center; }
    .row { display: flex; gap: 8px; margin-top: 14px; }
    .btn { flex: 1; height: 40px; border-radius: 8px; border: 1px solid #dee2e6; background: #fff; color: #212529; font-weight: 500; font-size: 14px; cursor: pointer; transition: background .15s, box-shadow .15s; }
    .btn:hover:not(:disabled) { background: #f8f9fa; }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn.primary { background: #3257F7; border-color: #3257F7; color: #fff; }
    .btn.primary:hover:not(:disabled) { background: #2443d9; box-shadow: 0 2px 10px rgba(50,87,247,.4); }
    .btn.amber { background: #fff3cd; border-color: #ffe69c; color: #664d03; }
    .btn.amber:hover:not(:disabled) { background: #ffecb5; }
    .btn.green { background: #d1e7dd; border-color: #a3cfbb; color: #0f5132; }
    .btn.green:hover:not(:disabled) { background: #bcdccd; }
    .btn.danger { background: #f8d7da; border-color: #f1aeb5; color: #842029; }
    .btn.danger:hover:not(:disabled) { background: #f1c2c7; }
    .tiny { display: block; margin: 10px auto 0; border: none; background: none; color: #adb5bd; font-size: 11.5px; cursor: pointer; }
    .tiny:hover { color: #6c757d; text-decoration: underline; }
    .link { display: block; margin: 12px auto 0; border: none; background: none; color: #6c757d; font-size: 13px; cursor: pointer; text-decoration: underline; }
    .lbl { font-size: 12px; font-weight: 600; color: #6c757d; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .dp { border: 1px solid transparent; border-radius: 8px; padding: 7px 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .dp.sel { border-color: currentColor; box-shadow: 0 0 0 3px rgba(33,37,41,.08); }
    .dp:hover { filter: brightness(.96); }
    .note { width: 100%; margin-top: 8px; border: 1px solid #dee2e6; border-radius: 8px; padding: 8px 10px; font-size: 13px; outline: none; }
    .note:focus { border-color: #86a0fb; box-shadow: 0 0 0 .22rem rgba(50,87,247,.18); }
    .cd { height: 5px; background: #e9ecef; border-radius: 99px; overflow: hidden; margin-top: 12px; }
    .cd i { display: block; height: 100%; background: #3257F7; }
    .next { margin-top: 10px; font-size: 13px; color: #6c757d; }
    .next b { color: #212529; }
    .done { text-align: center; padding: 16px 8px; font-weight: 600; color: #0f5132; background: #d1e7dd; border-radius: 10px; margin-top: 12px; }
    .mini { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid #dee2e6; border-radius: 999px; padding: 8px 16px 8px 10px; box-shadow: 0 .5rem 1.5rem rgba(33,37,41,.22); cursor: pointer; font-weight: 600; font-size: 14px; }
    .mini img { height: 24px; }
  `;
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const btn = (cls, text, onclick, disabled) => h('button', { class: 'btn ' + cls, onclick, disabled }, text);

  function ensureWidget() {
    if (host && host.isConnected) return;
    host = h('div', { id: 'gvl-dialer' });
    shadow = host.attachShadow({ mode: 'open' });
    body = h('div', { class: 'wrap' });
    shadow.append(h('style', {}, CSS), body);
    document.body.appendChild(host);
  }
  function removeWidget() {
    if (host) { host.remove(); host = null; }
  }

  function chipInfo() {
    const c = GVL.state.call;
    if (D.phase === 'dialing') return ['amber', 'Dialing…'];
    if (D.phase === 'incall') return c ? (c.talkMs >= 1000 ? ['green', 'On call · ' + GVL.fmtDur(c.talkMs / 1000)] : ['amber', 'Ringing…']) : ['slate', 'Wrapping up…'];
    if (D.phase === 'wrapup') return ['blue', 'Call ended · ' + GVL.fmtDur(D.lastRec?.durationSec || 0)];
    if (!Q.next && Q.called > 0) return ['green', 'All done'];
    if (D.mode === 'paused') return ['amber', 'Paused'];
    if (D.mode === 'running') return ['green', 'Auto-dialing'];
    return ['slate', 'Ready'];
  }
  function updateChip() {
    if (!chipEl) return;
    const [color, text] = chipInfo();
    chipEl.className = 'chip ' + color;
    chipEl.textContent = text;
  }

  function leadBlock(lead) {
    if (!lead) return null;
    const title = lead.name || lead.company || lead.number;
    const initials = (lead.name || lead.company || '#').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    return [
      h('div', { class: 'lead' },
        h('div', { class: 'av' }, initials || '#'),
        h('div', {},
          h('div', { class: 'n' }, title),
          lead.name && lead.company ? h('div', { class: 'c' }, lead.company) : null,
          h('div', { class: 'p' }, lead.number))),
      lead.notes ? h('div', { class: 'notes' }, lead.notes) : null
    ];
  }

  function wrapupView() {
    const rec = D.lastRec || {};
    const noteIn = h('input', { class: 'note', placeholder: 'Add a note (optional)', maxlength: 300 });
    noteIn.addEventListener('focus', cancelCountdown);
    noteIn.addEventListener('keydown', e => { if (e.key === 'Enter') noteIn.blur(); });
    noteIn.addEventListener('blur', async () => {
      if (noteIn.value.trim() && D.lastRec) await GVL.updateCall(D.lastRec.id, { notes: noteIn.value.trim() });
      if (D.mode === 'running' && mine() && D.phase === 'wrapup' && !countdown) { startCountdown(); render(); }
    });
    const grid = h('div', { class: 'grid' }, GRID.map(k => {
      const [fg, bgc] = COLORS[k];
      return h('button', {
        class: 'dp' + (rec.disposition === k ? ' sel' : ''), style: `color:${fg};background:${bgc}`,
        onclick: () => setDisposition(k, noteIn.value.trim())
      }, (rec.disposition === k ? '✓ ' : '') + GVL.label(k));
    }));
    const extra = GRID.includes(rec.disposition) ? null : h('div', { class: 'hint' }, 'Auto-detected: ' + GVL.label(rec.disposition));
    let bar = null;
    if (countdown) {
      const left = Math.max(0, countdown.endsAt - Date.now());
      const i = h('i', { style: `width:${(left / countdown.ms) * 100}%;transition:width ${left}ms linear` });
      bar = h('div', { class: 'cd' }, i);
      requestAnimationFrame(() => requestAnimationFrame(() => { i.style.width = '0%'; }));
    }
    return [
      h('div', { class: 'lbl' }, rec.auto ? 'How did it go? (auto-detected, tap to change)' : 'Result saved'),
      grid, extra, noteIn, bar,
      countdown ? h('div', { class: 'hint' }, 'Next call starts automatically. Hover here to hold.') : null
    ];
  }

  function actions() {
    if (!Q.next && Q.called > 0 && D.phase !== 'wrapup' && !live()) return h('div', { class: 'done' }, 'All numbers called. Great work!');
    const box = h('div');
    if (live()) box.append(h('div', { class: 'row' }, btn('danger', GVL.state.call ? 'Hang up' : 'Cancel dialing', hangUp)));
    const row = h('div', { class: 'row' });
    if (D.mode === 'idle') row.append(btn('primary', '▶  Start dialing', startAuto, !Q.next || live()));
    else if (D.mode === 'running') row.append(btn('amber', '❚❚  Pause', pause));
    else row.append(
      btn('primary', 'Dial next ›', dialNext, live() || !Q.next),
      btn('green', '▶ Resume auto', startAuto, !Q.next && !live() && D.phase !== 'wrapup'));
    box.append(row);
    return box;
  }

  function cardView() {
    const total = Q.called + Q.pending;
    const pct = total ? Math.round((Q.called / total) * 100) : 0;
    const showLead = D.phase === 'dialing' || D.phase === 'incall' || D.phase === 'wrapup' || D.awaiting ? D.lead : Q.next;
    const [color, text] = chipInfo();
    chipEl = h('span', { class: 'chip ' + color }, text);
    const otherTab = D.mode !== 'idle' && D.owner && D.owner !== tabId;
    const dbgBtn = h('button', { class: 'tiny' }, 'Copy debug info');
    dbgBtn.addEventListener('click', () => copyDebug(dbgBtn));
    const card = h('div', { class: 'card' },
      h('div', { class: 'head' },
        h('img', { src: BRAND.icon, alt: '' }), h('span', { class: 't' }, 'Dialer'), h('span', { class: 'sp' }),
        h('span', { class: 'cnt' }, `${Q.called} / ${total}`),
        h('button', { class: 'iconbtn', title: 'Minimize', onclick: async () => { await setD({ minimized: true }); render(); } }, '–')),
      h('div', { class: 'prog' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'main' },
        chipEl,
        h('span', { style: 'margin-left:8px;font-size:12px;color:#6c757d' }, `${Q.pending} left`),
        D.msg ? h('div', { class: 'alert' }, D.msg) : null,
        showLead ? leadBlock(showLead) : (Q.loaded && !Q.next ? h('div', { class: 'hint', style: 'margin:16px 0' }, 'No numbers waiting right now.') : null),
        D.phase === 'wrapup' ? wrapupView() : null,
        D.phase === 'wrapup' && !Q.next && Q.called > 0 ? h('div', { class: 'next' }, 'That was the last number on your list. 🎉') : null,
        D.phase === 'wrapup' && Q.next && !countdown
          ? h('div', { class: 'next' }, 'Up next: ', h('b', {}, Q.next.name || Q.next.number), Q.next.name ? ` · ${Q.next.number}` : '') : null,
        actions(),
        otherTab ? h('div', { class: 'hint' }, 'Dialer is active in another Google Voice tab. Using a button here takes over.') : null,
        (D.phase === 'idle' || D.phase === 'wrapup') && Q.next && D.mode !== 'running' && !live()
          ? h('button', { class: 'link', onclick: skipNext }, 'Skip this number') : null,
        D.mode === 'paused' && live() ? h('div', { class: 'hint' }, 'Paused. Auto-dial will wait after this call.') : null,
        dbgBtn));
    if (D.phase === 'wrapup') {
      card.addEventListener('mouseenter', () => { if (countdown) { cancelCountdown(); held = true; render(); } });
      card.addEventListener('mouseleave', () => {
        if (!held) return;
        held = false;
        if (D.mode === 'running' && mine() && D.phase === 'wrapup') { startCountdown(3); render(); }
      });
    }
    return card;
  }

  function miniView() {
    return h('div', { class: 'mini', onclick: async () => { await setD({ minimized: false }); render(); } },
      h('img', { src: BRAND.icon, alt: '' }), `${Q.pending} to call`);
  }

  function render() {
    const hasQueue = Q.pending > 0 || Q.called > 0;
    if (!signedIn || (!hasQueue && D.mode === 'idle' && D.phase === 'idle')) return removeWidget();
    ensureWidget();
    const focused = shadow.activeElement;
    if (focused && focused.tagName === 'INPUT') return;
    body.replaceChildren(D.minimized ? miniView() : cardView());
  }

  // ---------- boot ----------
  chrome.storage.onChanged.addListener(ch => {
    if (ch.dialer) { D = { ...DEFAULT, ...(ch.dialer.newValue || {}) }; render(); }
    if (ch.session) {
      signedIn = !!ch.session.newValue;
      if (signedIn) refreshQueue(); else { Q = { next: null, pending: 0, called: 0, loaded: false }; render(); }
    }
  });
  try {
    chrome.runtime.onMessage.addListener(msg => { if (msg && msg.type === 'dialLead') dialLead(msg.lead); });
  } catch (e) { /* not in an extension context */ }
  setInterval(updateChip, 1000);
  setInterval(() => { if (signedIn && !live() && !countdown) refreshQueue(); }, 45000);

  (async () => {
    const st = await chrome.storage.local.get(['dialer', 'session']);
    D = { ...DEFAULT, ...(st.dialer || {}) };
    signedIn = !!st.session;
    if (signedIn) await refreshQueue(); else render();
    if (D.phase === 'dialing' && mine()) watchDial();
    // A redial requested from the popup while no Google Voice tab was open.
    const req = (await chrome.storage.local.get('dialRequest')).dialRequest;
    if (req) {
      await chrome.storage.local.remove('dialRequest');
      if (Date.now() - req.ts < 60000 && signedIn) setTimeout(() => dialLead(req.lead), 3500);
    }
    if (D.phase === 'incall' && mine()) {
      setTimeout(async () => {
        if (D.phase === 'incall' && !GVL.state.call) { await setD({ phase: 'idle', mode: 'paused', msg: 'The last call was interrupted. Press Dial next when ready.' }); render(); }
      }, 6000);
    }
  })();
})();
