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

  const DEFAULT = { auto: false, mode: 'idle', phase: 'idle', lead: null, owner: null, since: 0, msg: '', lastRec: null, minimized: false, awaiting: false };
  let D = { ...DEFAULT };
  let Q = { next: null, pending: 0, called: 0, loaded: false };
  let signedIn = false;
  let countdown = null;
  let held = false;
  let host = null, shadow = null, body = null, chipEl = null;

  const SHOW_AUTO = !!(typeof CFG !== 'undefined' && CFG.SHOW_AUTO_TOGGLE); // auto-dial switch hidden for now; set to true in config.js to bring it back
  const autoOn = () => SHOW_AUTO && !!D.auto;
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
    if (r.ok) Q = { ...r.data, loaded: true, err: '' };
    else Q = { ...Q, loaded: true, err: r.error || 'Could not reach the server.' };
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

  // Is any call showing in Google Voice right now (ours, ringing, or one on hold with a "Switch" button)?
  // Dialing while one is up makes Google put the first call on hold and start a second one.
  function holdVisible() {
    try { return holdVisible2(); } catch (e) { return false; }
  }
  function holdVisible2() {
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      if (!visible(b) || (b.closest && b.closest('#gvl-dialer'))) continue;
      if (/^switch$/i.test((b.textContent || '').trim()) || /^switch/i.test(b.getAttribute('aria-label') || '')) return true;
    }
    return /\bon hold\b/i.test((document.querySelector('[role="main"]') || document.body).innerText || '');
  }
  const callUi = () => !!GVL.state.call || (GVL.actions.callActive ? GVL.actions.callActive() : false) || holdVisible();
  async function waitFor(test, ms, stopped) { const end = Date.now() + ms * SCALE; while (Date.now() < end) { if (test() || stopped()) return test(); await sleep(200); } return test(); }

  // Type the number into Google Voice's dial box and start the call ONCE, without leaving the page.
  async function dialInPage(number, since) {
    const stopped = () => D.phase !== 'dialing' || D.since !== since;
    const started = () => callUi();
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
    // Google can take a few seconds to show the call. Wait for it instead of clicking again:
    // a second click starts a second call and puts the first one on hold.
    if (await waitFor(started, 4500, stopped) || stopped()) return started();
    clickCall(); // Enter didn't start it: press the Call button exactly once
    return waitFor(started, 9000, stopped);
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
      if (callUi()) return clearInterval(iv);
      if (age > 4000 && clicks < 1 && clickCall()) { clicks++; lastClick = Date.now(); } // one click at most
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
    if (callUi()) { await setD({ msg: 'A call is still open or on hold in Google Voice. Hang it up (or end the held call) before dialing the next number.' }); return render(); }
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
    if (live() || callUi()) { await setD({ msg: 'Finish or hang up the current call first (including any call on hold).' }); return render(); }
    cancelCountdown();
    await setD({ mode: 'paused', minimized: false });
    await beginDial({ id: lead.id, number: lead.number, name: lead.name || '', company: lead.company || '', notes: lead.notes || '', extra: Array.isArray(lead.extra) ? lead.extra : [] });
  }

  async function beginDial(target) {
    await setD({ owner: tabId, phase: 'dialing', lead: target, since: Date.now(), msg: '', lastRec: null, awaiting: false });
    render();
    const since = D.since, lead = D.lead;
    const ok = await dialInPage(lead.number, since);
    if (ok || callUi() || D.phase !== 'dialing' || D.since !== since) return;
    // Reloading with Google's dial link is off by default: if the first call did start late, it would place a second one.
    if (CFG.DIAL_FALLBACK_RELOAD === true && !callUi()) { location.assign(dialUrl(lead.number)); return; }
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
  async function setAuto(on) {
    cancelCountdown();
    if (on) await setD({ auto: true });
    else await setD({ auto: false, mode: D.mode === 'idle' ? 'idle' : 'paused', msg: '' });
    render();
  }
  function autoSwitch() {
    if (!SHOW_AUTO) return null;
    const input = h('input', { type: 'checkbox', onchange: e => setAuto(e.target.checked) });
    input.checked = !!D.auto;
    return h('label', { class: 'sw', title: 'When on, the next number is dialed automatically after each call' },
      input, h('span', { class: 'knob' }), h('span', { class: 'swt' }, 'Auto-dial'));
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
    setD({ phase: 'wrapup', since: Date.now(), lastRec: { id: rec.id, disposition: rec.disposition, durationSec: rec.durationSec, endedBy: rec.endedBy, auto: true } }).then(render);
    (async () => {
      const done = rec.leadId === 'adhoc' ? { ok: true } : await bg({ type: 'leadDone', id: rec.leadId });
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
    await setD({ lastRec: { ...D.lastRec, disposition: k, auto: false, edit: false } });
    if (D.mode === 'running' && mine()) { cancelCountdown(); dialNext(); } else render();
  }

  // ---------- widget ----------
  const COLORS = {
    answered: ['#0f5132', '#d1e7dd'], interested: ['#084298', '#cfe2ff'], not_interested: ['#912018', '#fde2e1'], callback: ['#664d03', '#fff3cd'], voicemail: ['#5925dc', '#e5dcfb'], no_answer: ['#495057', '#e9ecef'],
    busy: ['#664d03', '#fff3cd'], dead_number: ['#842029', '#f8d7da'], wrong_number: ['#984c0c', '#ffe5d0'],
    do_not_call: ['#58151c', '#f5c2c7'], other: ['#343a40', '#f1f3f5'], cancelled: ['#495057', '#e9ecef']
  };
  const GRID = ['interested', 'not_interested', 'callback', 'answered', 'voicemail', 'no_answer', 'busy', 'dead_number', 'wrong_number', 'do_not_call', 'other'];

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
    .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; color: #212529; font-size: 14px; line-height: 1.45; }
    .card { width: 380px; max-height: calc(100vh - 36px); display: flex; flex-direction: column; background: #fff; border: 1px solid #dee2e6; border-radius: 14px; box-shadow: 0 .75rem 2rem rgba(33,37,41,.22); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #fff; border-bottom: 1px solid #e9ecef; }
    .head img { height: 24px; display: block; }
    .head .t { font-weight: 600; font-size: 15px; }
    .head .sp { flex: 1; }
    .head .cnt { font-size: 12px; font-weight: 600; color: #3257F7; background: #eef2ff; padding: 3px 10px; border-radius: 999px; }
    .iconbtn { border: none; background: none; cursor: pointer; font-size: 20px; color: #6c757d; line-height: 1; padding: 0 6px; border-radius: 6px; }
    .iconbtn:hover { background: #f1f3f5; color: #212529; }
    .prog { height: 6px; background: #e9ecef; }
    .prog i { display: block; height: 100%; background: linear-gradient(90deg, #3257F7, #6d8bff); transition: width .4s; }
    .main { padding: 18px 18px 16px; overflow: auto; }
    .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; }
    .chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .chip.slate { background: #e9ecef; color: #495057; } .chip.blue { background: #eef2ff; color: #3257F7; }
    .chip.green { background: #d1e7dd; color: #0f5132; } .chip.amber { background: #fff3cd; color: #664d03; }
    .chip.amber::before, .chip.green::before { animation: pulse 1.2s infinite; }
    @keyframes pulse { 50% { opacity: .3; } }
    .lead { margin: 14px 0 10px; padding: 16px; border: 1px solid #e6e9f2; border-radius: 16px; background: linear-gradient(180deg, #f7f9ff 0%, #fff 100%); }
    .lead-top { display: flex; gap: 14px; align-items: center; }
    .av { width: 52px; height: 52px; border-radius: 50%; flex: none; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 17px; background: linear-gradient(135deg, #3257F7, #7a5af8); box-shadow: 0 4px 12px rgba(50,87,247,.25); }
    .av.anon { background: #e9ecef; color: #6c757d; box-shadow: none; font-size: 20px; }
    .who { min-width: 0; }
    .lead .n { font-size: 17px; font-weight: 700; line-height: 1.25; color: #101828; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: -.01em; }
    .lead .c { color: #667085; font-size: 13px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ph { display: inline-flex; align-items: center; gap: 8px; margin-top: 12px; padding: 7px 12px 7px 8px; border-radius: 999px; background: #eef2ff; color: #2443d9; font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
    .phi { width: 22px; height: 22px; border-radius: 50%; background: #3257F7; color: #fff; display: grid; place-items: center; font-size: 11px; }
    .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px dashed #dfe3ec; }
    .tile { min-width: 0; padding: 9px 11px; border-radius: 12px; background: #fff; border: 1px solid #eaecf0; }
    .tile.wide { grid-column: 1 / -1; }
    .tile.hl { background: #fffaeb; border-color: #fedf89; }
    .tl { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #98a2b3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tile.hl .tl { color: #b54708; }
    .tile.missing { background: #f9fafb; border-style: dashed; } .tile.missing .tv { color: #98a2b3; font-weight: 500; font-style: italic; }
    .none { color: #98a2b3 !important; font-style: italic; font-weight: 500 !important; }
    .lmini { display: flex; gap: 10px; align-items: center; margin: 12px 0 0; padding: 10px 12px; border: 1px solid #eaecf0; border-radius: 12px; background: #f9fafb; }
    .av.sm { width: 34px; height: 34px; font-size: 12.5px; box-shadow: none; }
    .ln { font-size: 14px; font-weight: 700; color: #101828; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ls { font-size: 12px; color: #667085; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .outcome { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 12px; font-size: 12.5px; }
    .oc-l { color: #667085; font-weight: 600; }
    .oc-v { font-weight: 700; padding: 3px 9px; border-radius: 999px; font-size: 12px; }
    .oc-by { color: #667085; }
    .tv { font-size: 14px; font-weight: 600; color: #101828; margin-top: 2px; overflow-wrap: anywhere; line-height: 1.3; }
    .upnext { margin-top: 12px; padding: 10px 12px; border-radius: 12px; border: 1px dashed #c7d2fe; background: #f8faff; display: flex; gap: 10px; align-items: center; }
    .un-b { min-width: 0; flex: 1; }
    .un-l { flex: none; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: #fff; background: #3257F7; padding: 3px 7px; border-radius: 6px; }
    .un-n { font-size: 13px; font-weight: 600; color: #344054; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .un-s { font-size: 12px; color: #667085; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .un-p { font-size: 15px; color: #101828; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
    .notes { background: #fff; border: 1px solid #e9ecef; border-radius: 10px; padding: 8px 10px; font-size: 12.5px; color: #495057; margin: 8px 0; max-height: 64px; overflow: auto; }
    .alert { background: #fff3cd; border: 1px solid #ffe69c; color: #664d03; border-radius: 10px; padding: 9px 12px; font-size: 13px; margin: 12px 0 0; }
    .hint { color: #6c757d; font-size: 12.5px; margin: 10px 0 0; text-align: center; }
    .sw { display: flex; align-items: center; gap: 8px; margin: 10px 0 2px; cursor: pointer; font-size: 13px; font-weight: 600; color: #495057; }
    .sw input { position: absolute; opacity: 0; width: 0; height: 0; }
    .sw .knob { position: relative; width: 38px; height: 22px; border-radius: 999px; background: #ced4da; transition: background .15s; flex: none; }
    .sw .knob::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
    .sw input:checked + .knob { background: #198754; }
    .sw input:checked + .knob::after { transform: translateX(16px); }
    .sw input:focus-visible + .knob { outline: 2px solid #3257F7; outline-offset: 2px; }
    .vvfoot { text-align: center; margin-top: 12px; padding-top: 8px; border-top: 1px solid #eef0f2; font-size: 11px; color: #8a949e; }
    .vvfoot a.vv { color: #8a949e; text-decoration: none; display: inline-flex; align-items: center; gap: 0; }
    .vvfoot a.vv b { color: #282340 !important; font-family: Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; font-weight: 600; font-size: 12px; letter-spacing: -0.35px; line-height: 1; }
    .vv-p { height: 15px; width: auto; margin: 0 1px 0 5px; }
    .row { display: flex; gap: 8px; margin-top: 14px; }
    .btn { flex: 1; height: 44px; border-radius: 10px; border: 1px solid #dee2e6; background: #fff; color: #212529; font-weight: 500; font-size: 14px; cursor: pointer; transition: background .15s, box-shadow .15s; }
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
    .saved { margin-top: 14px; padding: 10px 12px; border-radius: 10px; background: #d1e7dd; color: #0f5132; font-weight: 600; font-size: 13.5px; }
    .tiny { display: block; margin: 10px auto 0; border: none; background: none; color: #adb5bd; font-size: 11.5px; cursor: pointer; }
    .tiny:hover { color: #6c757d; text-decoration: underline; }
    .link { display: block; margin: 12px auto 0; border: none; background: none; color: #6c757d; font-size: 13px; cursor: pointer; text-decoration: underline; }
    .lbl { font-size: 11px; font-weight: 700; color: #667085; margin: 12px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .dp { border: 1px solid transparent; border-radius: 8px; padding: 7px 4px; font-size: 12px; font-weight: 600; cursor: pointer; line-height: 1.2; min-height: 34px; }
    .dp.sel { border-color: currentColor; box-shadow: 0 0 0 3px rgba(33,37,41,.08); }
    .dp:hover { filter: brightness(.96); }
    .note { width: 100%; margin-top: 8px; height: 36px; border: 1px solid #dee2e6; border-radius: 8px; padding: 8px 10px; font-size: 13px; outline: none; }
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
    if (!autoOn()) return ['slate', 'Manual'];
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

  const fmtNum = n => { const m = String(n || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : String(n || ''); };
  const mcOf = lead => ((lead.extra || []).find(e => /^mc\b|mc ?(number|#|no)/i.test(e.l)) || {}).v || '';

  const isMc = l => /^mc\b|mc ?(number|#|no)/i.test(l);
  const mcClean = v => String(v || '').replace(/^mc[-\s#:]*/i, '');

  // Full contact card (before / during a call)
  function leadBlock(lead) {
    if (!lead) return null;
    const name = lead.name || '', co = lead.company || '', mc = mcOf(lead);
    const initials = (name || co).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const extra = (Array.isArray(lead.extra) ? lead.extra : []).filter(e => e && e.v && !isMc(e.l));
    const tile = (l, v, cls = '') => h('div', { class: 'tile ' + cls + (String(v).length > 20 ? ' wide' : '') }, h('div', { class: 'tl' }, l), h('div', { class: 'tv', title: v }, v));
    return [
      h('div', { class: 'lead' },
        h('div', { class: 'lead-top' },
          h('div', { class: 'av' + (initials ? '' : ' anon') }, initials || '?'),
          h('div', { class: 'who' },
            h('div', { class: 'n' + (name ? '' : ' none'), title: name }, name || 'No name'),
            h('div', { class: 'c' + (co ? '' : ' none'), title: co }, co || 'No company'))),
        h('div', { class: 'ph' }, h('span', { class: 'phi' }, '☎'), fmtNum(lead.number)),
        h('div', { class: 'tiles' },
          mc ? tile('MC number', mc, 'hl') : tile('MC number', 'No MC number', 'missing'),
          extra.map(e => tile(e.l, e.v)))),
      lead.notes ? h('div', { class: 'notes' }, lead.notes) : null
    ];
  }

  // One-line summary of the call that just ended, so the result buttons fit without scrolling
  function leadMini(lead) {
    if (!lead) return null;
    const name = lead.name || lead.company || '', mc = mcOf(lead);
    return h('div', { class: 'lmini' },
      h('div', { class: 'av sm' + (name ? '' : ' anon') }, name ? name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() : '?'),
      h('div', { class: 'who' },
        h('div', { class: 'ln' + (name ? '' : ' none') }, name || 'No name'),
        h('div', { class: 'ls' }, fmtNum(lead.number) + '  ·  ' + (mc ? 'MC ' + mcClean(mc) : 'No MC number'))));
  }

  function upNext(l) {
    const mc = mcOf(l);
    return h('div', { class: 'upnext' },
      h('div', { class: 'un-b' },
        h('div', { class: 'un-p' }, fmtNum(l.number)),
        h('div', { class: 'un-n' + (l.name ? '' : ' none') }, l.name || 'No name'),
        h('div', { class: 'un-s' }, [l.company, mc ? 'MC ' + mcClean(mc) : 'No MC number'].filter(Boolean).join('  ·  '))));
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
    let bar = null;
    if (countdown) {
      const left = Math.max(0, countdown.endsAt - Date.now());
      const i = h('i', { style: `width:${(left / countdown.ms) * 100}%;transition:width ${left}ms linear` });
      bar = h('div', { class: 'cd' }, i);
      requestAnimationFrame(() => requestAnimationFrame(() => { i.style.width = '0%'; }));
    }
    if (rec.auto === false && !rec.edit) { // the agent already chose: collapse the panel
      return [h('div', { class: 'saved' }, '✓ Saved as ' + GVL.label(rec.disposition) + '  ',
        h('button', { class: 'tiny', style: 'display:inline;margin:0 0 0 6px', onclick: async () => { await setD({ lastRec: { ...D.lastRec, edit: true } }); render(); } }, 'Change'))];
    }
    const by = rec.endedBy === 'agent' ? (rec.disposition === 'cancelled' ? 'You hung up before anyone answered' : 'You hung up') : rec.endedBy ? 'They ended the call' : '';
    return [
      h('div', { class: 'outcome' },
        h('span', { class: 'oc-l' }, rec.auto ? 'Detected' : 'Result'),
        h('span', { class: 'oc-v', style: `color:${(COLORS[rec.disposition] || COLORS.other)[0]};background:${(COLORS[rec.disposition] || COLORS.other)[1]}` }, GVL.label(rec.disposition)),
        by ? h('span', { class: 'oc-by' }, by) : null),
      h('div', { class: 'lbl' }, 'How did it go?'),
      grid, noteIn, bar,
      countdown ? h('div', { class: 'hint' }, 'Next call starts automatically. Hover here to hold.') : null
    ];
  }

  async function manualRefresh(e) {
    const b = e && e.currentTarget; if (b) { b.disabled = true; b.textContent = 'Checking…'; }
    await refreshQueue();
  }
  function actions() {
    if (!Q.next && Q.pending + Q.called === 0 && D.phase === 'idle' && !live()) {
      return h('div', {}, h('div', { class: 'hint', style: 'margin:14px 0 4px' },
        Q.err ? "Couldn't load your list: " + Q.err : (Q.loaded ? 'No leads yet. Your admin has not assigned any, or the list is disabled.' : 'Loading your list…')),
        h('div', { class: 'row' }, btn('primary', '↻ Refresh', manualRefresh)));
    }
    if (!Q.next && Q.called > 0 && D.phase !== 'wrapup' && !live()) return h('div', { class: 'done' }, 'All numbers called. Great work!');
    const box = h('div');
    if (live()) box.append(h('div', { class: 'row' }, btn('danger', GVL.state.call ? 'Hang up' : 'Cancel dialing', hangUp)));
    const row = h('div', { class: 'row' });
    if (!autoOn()) row.append(btn('primary', 'Dial next ›', dialNext, live() || !Q.next));
    else if (D.mode === 'idle') row.append(btn('primary', '▶  Start dialing', startAuto, !Q.next || live()));
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
    const card = h('div', { class: 'card' },
      h('div', { class: 'head' },
        h('img', { src: BRAND.icon, alt: '' }), h('span', { class: 't' }, 'Dialer'), h('span', { class: 'sp' }),
        h('span', { class: 'cnt' }, `${Q.called} / ${total}`),
        h('button', { class: 'iconbtn', title: 'Minimize', onclick: async () => { await setD({ minimized: true }); render(); } }, '–')),
      h('div', { class: 'prog' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'main' },
        chipEl,
        h('span', { style: 'margin-left:8px;font-size:12px;color:#6c757d' }, `${Q.pending} left`),
        autoSwitch(),
        D.msg ? h('div', { class: 'alert' }, D.msg) : null,
        showLead ? (D.phase === 'wrapup' ? leadMini(showLead) : leadBlock(showLead)) : (Q.loaded && !Q.next ? h('div', { class: 'hint', style: 'margin:16px 0' }, 'No numbers waiting right now.') : null),
        D.phase === 'wrapup' ? wrapupView() : null,
        D.phase === 'wrapup' && !Q.next && Q.called > 0 ? h('div', { class: 'next' }, 'That was the last number on your list. 🎉') : null,
        D.phase === 'wrapup' && Q.next && !countdown
          ? upNext(Q.next) : null,
        actions(),
        otherTab ? h('div', { class: 'hint' }, 'Dialer is active in another Google Voice tab. Using a button here takes over.') : null,
        (D.phase === 'idle' || D.phase === 'wrapup') && Q.next && D.mode !== 'running' && !live()
          ? h('button', { class: 'link', onclick: skipNext }, 'Skip this number') : null,
        autoOn() && D.mode === 'paused' && live() ? h('div', { class: 'hint' }, 'Paused. Auto-dial will wait after this call.') : null,
        h('div', { class: 'vvfoot' }, h('a', { class: 'vv', href: 'https://veefivee.com', target: '_blank', rel: 'noopener' }, 'Developed by ', h('img', { class: 'vv-p', src: BRAND.palm, alt: '' }), h('b', {}, 'veefivee')))));
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
    if (!signedIn) return removeWidget(); // otherwise always show the window, even with no leads (it offers Refresh)
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
