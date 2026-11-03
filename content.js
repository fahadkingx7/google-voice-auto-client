// Runs on voice.google.com. Watches for an active call, logs the outcome locally;
// background.js uploads it to the team database.
(() => {
  if (window.__gvlLoaded) return;
  window.__gvlLoaded = true;

  // ---- Tunable selectors / phrases (Google changes its UI; adjust here if detection breaks) ----
  const END_BTN = [
    '[aria-label*="end call" i]',
    '[aria-label*="hang up" i]',
    '[aria-label*="end the call" i]',
    '[data-tooltip*="end call" i]',
    '[mattooltip*="end call" i]'
  ].join(',');
  const DEAD_RE = /not in service|no longer in service|has been disconnected|number is disconnected|isn['’]t a valid|not a valid|invalid number|can['’]t be completed as dialed|number you have dialed/i;
  const BUSY_RE = /\bbusy\b/i;
  const FAIL_RE = /call failed|couldn['’]t (?:place|complete|connect)|unable to (?:place|complete|connect)|call could not be/i;
  const VM_RE = /leave a message|voicemail|after the tone|not available/i;
  const INCOMING_RE = /incoming call|is calling/i;

  const END_RE = /\b(end|hang ?up|hangup)\b.*\bcall\b|\bcall\b.*\b(end|hang ?up)\b|^hang ?up$|^end call$/i;
  const isVisible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  // The red "end call" button is how we know a call is live. Match by label, tooltip, text or icon name,
  // and only if it is actually on screen.
  function findEndButton() {
    for (const b of document.querySelectorAll(END_BTN)) if (isVisible(b)) return b;
    for (const b of document.querySelectorAll('button,[role="button"]')) {
      if (!isVisible(b)) continue;
      const label = ['aria-label', 'title', 'data-tooltip', 'mattooltip'].map(a => b.getAttribute(a)).filter(Boolean).join(' ');
      if (END_RE.test(label) || END_RE.test((b.textContent || '').trim())) return b;
      const icon = b.querySelector('mat-icon,i,[class*="material"],[class*="icon"]');
      if (icon && icon.textContent.trim() === 'call_end') return b;
    }
    return null;
  }

  function isEndButton(b) {
    if (!b || !b.matches) return false;
    if (b.matches(END_BTN)) return true;
    const label = ['aria-label', 'title', 'data-tooltip', 'mattooltip'].map(a => b.getAttribute(a)).filter(Boolean).join(' ');
    if (END_RE.test(label) || END_RE.test((b.textContent || '').trim())) return true;
    const icon = b.querySelector('mat-icon,i,[class*="material"],[class*="icon"]');
    return !!icon && icon.textContent.trim() === 'call_end';
  }

  // Remember WHO ended the call: any click on the end-call button during a call counts as the agent hanging up.
  // A call that ends without that click was ended by the other side (or the line).
  document.addEventListener('click', e => {
    if (!call) return;
    const b = e.target && e.target.closest ? e.target.closest('button,[role="button"]') : null;
    if (isEndButton(b)) call.endedBy = 'agent';
  }, true);

  // Lets the dialer check whether Google Voice shows an active call (so it never dials a second one on top).
  GVL.actions.callActive = () => !!findEndButton();

  // Lets the dialer's Hang up button end the call.
  GVL.actions.endCall = () => {
    const b = findEndButton();
    if (b) { if (call) call.endedBy = 'agent'; b.click(); return true; }
    return false;
  };

  // For support: what the page offers, so selectors can be fixed if Google changes its layout.
  GVL.actions.debug = () => {
    const desc = el => [
      el.tagName.toLowerCase(),
      ...['aria-label', 'title', 'data-tooltip', 'mattooltip', 'placeholder', 'type'].map(a => el.getAttribute(a) && `${a}="${el.getAttribute(a)}"`),
      (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) && `text="${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`
    ].filter(Boolean).join(' ');
    const end = findEndButton();
    const lines = [`page: ${location.pathname}${location.search}`, `call detected: ${!!GVL.state.call}`, `end-call button: ${end ? desc(end) : 'NOT FOUND'}`, '', 'Visible inputs:'];
    for (const i of document.querySelectorAll('input,textarea')) if (isVisible(i)) lines.push('  ' + desc(i));
    lines.push('', 'Visible buttons:');
    let n = 0;
    for (const b of document.querySelectorAll('button,[role="button"]')) { if (!isVisible(b)) continue; if (n++ > 150) break; lines.push('  ' + desc(b)); }
    return lines.join('\n');
  };

  const settings = { ...GVL.DEFAULT_SETTINGS };
  let call = null;

  // ---- call recording (recorder.js does the recording inside the page; this side uploads it) ----
  const REC_ON = typeof CFG !== 'undefined' && CFG.REC_ENABLED && CFG.REC_URL;
  const ORIGIN = 'https://voice.google.com';
  const recWait = new Map(); // key -> resolve(data)
  const broadcast = msg => {
    const send = w => { try { w.postMessage(msg, ORIGIN); } catch (e) { /* other origin */ } try { for (let i = 0; i < w.frames.length; i++) send(w.frames[i]); } catch (e) { /* no access */ } };
    send(window);
  };
  window.addEventListener('message', e => {
    if (e.origin !== ORIGIN || !e.data) return;
    if (e.data.__gvlRecState === 'recording' && call && call.recKey === e.data.key) recBadge(true);
    if (e.data.__gvlRecData && recWait.has(e.data.key)) { recWait.get(e.data.key)(e.data); recWait.delete(e.data.key); }
  });
  function recStart(c) {
    if (!REC_ON) return;
    c.recKey = GVL.uid();
    broadcast({ __gvlRec: 'start', key: c.recKey });
  }
  function recStop(c) {
    recBadge(false);
    if (!c.recKey) return null;
    const p = new Promise(res => { recWait.set(c.recKey, res); setTimeout(() => { if (recWait.has(c.recKey)) { recWait.delete(c.recKey); res(null); } }, 6000); });
    broadcast({ __gvlRec: 'stop', key: c.recKey });
    return p;
  }
  function recBadge(on) {
    let b = document.getElementById('gvl-rec');
    if (!on) { b?.remove(); return; }
    if (b) return;
    b = document.createElement('div');
    b.id = 'gvl-rec';
    b.innerHTML = '<i></i><span>Recording</span><small>Say: \u201cThis call may be recorded.\u201d</small>';
    document.body.appendChild(b);
  }
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
  const msg = m => new Promise(res => { try { chrome.runtime.sendMessage(m, r => res(r || {})); } catch (e) { res({}); } });
  async function recUpload(rec, data) {
    try {
      await msg({ type: 'sync' }); // make sure the call itself is saved first
      const type = (data.mime || 'audio/webm').split(';')[0];
      const fd = new FormData();
      fd.append('mix', new Blob([data.mix], { type }), rec.id + '.webm');
      // a base64 copy for the transcriber (encoding here keeps the server's work tiny) + who-was-talking levels
      fd.append('mix64', await toB64(new Blob([data.mix], { type })));
      if (Array.isArray(data.levels) && data.levels.length) fd.append('levels', JSON.stringify(data.levels));
      for (let attempt = 0; attempt < 3; attempt++) {
        const { token } = await msg({ type: 'token' });
        if (!token) return;
        for (const base of [CFG.REC_URL, CFG.REC_URL_BACKUP].filter(Boolean)) {
          try {
            const r = await fetch(`${base}/upload?call=${rec.id}&dur=${rec.durationSec}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
            if (r.ok || (r.status >= 400 && r.status < 500)) return;
            break; // the service answered with an error: wait and retry
          } catch (e) { /* this address can't be reached: try the backup */ }
        }
        await new Promise(s => setTimeout(s, 15000 * (attempt + 1)));
      }
    } catch (e) { /* recording is best-effort; the call itself is already logged */ }
  }

  const ping = () => {
    try {
      chrome.runtime.sendMessage({ type: 'heartbeat', onCall: !!call, number: call?.number || null }).catch(() => {});
    } catch (e) { /* extension reloaded */ }
  };

  function findContainer(btn) {
    let el = btn;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      if (GVL.extractNumber(el.innerText || '')) return el;
    }
    return btn.parentElement?.parentElement || btn;
  }

  function readTimerMs(c) {
    if (!c) return null;
    for (const n of c.querySelectorAll('*')) {
      if (n.children.length) continue;
      const m = n.textContent.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
      if (m) return ((+m[1] || 0) * 3600 + +m[2] * 60 + +m[3]) * 1000;
    }
    return null;
  }

  function guessLabel(text, number) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.find(l =>
      !/^\d{1,2}:\d{2}/.test(l) &&
      !/calling|ringing|connecting|end call|mute|keypad|hold|incoming|add call|ongoing|on call|call ended|call with|transfer|record/i.test(l) &&
      !/^[a-z]+(_[a-z]+)+$/.test(l) && // material icon names like "call_end", "mic_off"
      !/^[a-z_]+$/.test(l) &&
      !GVL.extractNumber(l)
    ) || '';
  }

  function tick() {
    const btn = findEndButton();
    if (btn) {
      const c = findContainer(btn);
      const text = (c?.innerText || '').trim();
      if (!call) {
        call = { startedAt: Date.now(), talkMs: 0, texts: new Set(), number: null, label: '', incoming: false, leadId: null, endedBy: null };
        GVL.state.call = call;
        call.leadId = GVL.hooks.onCallStart(call) || null;
        recStart(call); // the recorder listens from the start but only records once a voice is heard
        ping();
      }
      if (call.texts.size < 40) call.texts.add(text.slice(0, 600));
      const n = GVL.extractNumber(text);
      if (n) call.number = n;
      if (INCOMING_RE.test(text)) call.incoming = true;
      if (!call.label) call.label = guessLabel(text, call.number);
      const t = readTimerMs(c);
      if (t !== null && t >= 1000) call.talkMs = Math.max(call.talkMs, t);
    } else if (call) {
      const done = call;
      call = null;
      GVL.state.call = null;
      ping();
      done.recData = recStop(done);
      finish(done);
    }
  }

  function finish(c) {
    const endedAt = Date.now();
    // Error banners / snackbars usually appear just after the call ends.
    setTimeout(async () => {
      const extra = [...document.querySelectorAll('[role="alert"],[aria-live]:not([aria-live="off"]),[class*="snack" i],[class*="toast" i]')]
        .filter(e => !e.closest('#gvl-root'))
        .map(e => e.innerText || '')
        .join('\n');
      const all = [...c.texts].join('\n') + '\n' + extra;
      const connected = c.talkMs >= 1000;
      const durationSec = connected ? Math.round(c.talkMs / 1000) : 0;

      if (!connected && endedAt - c.startedAt < 1500 && !extra.trim() && !c.leadId) return; // accidental blip

      let disposition;
      if (DEAD_RE.test(all)) disposition = 'dead_number';
      else if (BUSY_RE.test(all) && !connected) disposition = 'busy';
      else if (FAIL_RE.test(all)) disposition = 'failed';
      else if (!connected && c.endedBy === 'agent' && !c.incoming) disposition = 'cancelled'; // agent hung up before anyone answered
      else if (connected && (VM_RE.test(all) || durationSec <= settings.voicemailMaxSec)) disposition = c.incoming ? 'answered' : 'voicemail';
      else if (connected) disposition = 'answered';
      else disposition = c.incoming ? 'missed' : 'no_answer';

      const rec = {
        id: GVL.uid(),
        number: (c.leadId && GVL.state.leadNumber) || c.number || 'unknown',
        label: c.leadId ? (GVL.state.leadLabel || '') : (c.label || ''), // dialer calls: only the lead's own name
        direction: c.incoming ? 'incoming' : 'outgoing',
        startedAt: c.startedAt,
        endedAt,
        durationSec,
        disposition,
        autoDisposition: disposition,
        dispositionSource: 'auto',
        leadId: c.leadId || null,
        endedBy: c.endedBy === 'agent' ? 'agent' : 'remote',
        notes: ''
      };
      await GVL.saveCall(rec);
      if (!GVL.hooks.onCallRecorded(rec)) showToast(rec);
      if (c.recData) {
        const data = await c.recData;
        const SKIP = ['voicemail', 'no_answer', 'busy', 'failed', 'dead_number', 'cancelled', 'missed'];
        if (data && data.picked && data.mix && connected && Math.round(data.ms / 1000) >= (CFG.REC_MIN_SEC || 20) && !SKIP.includes(disposition))
          recUpload({ ...rec, durationSec: Math.round(data.ms / 1000) }, data);
      }
    }, 2500);
  }

  // ---- Post-call confirmation panel (record is already saved/queued; this lets the agent correct it) ----
  function showToast(rec) {
    if (!settings.promptEnabled) return;
    document.getElementById('gvl-root')?.remove();
    const root = document.createElement('div');
    root.id = 'gvl-root';

    const head = document.createElement('div');
    head.className = 'gvl-head';
    const title = document.createElement('strong');
    title.textContent = `${rec.label && rec.label !== rec.number ? rec.label + ' · ' : ''}${rec.number}`;
    const sub = document.createElement('span');
    sub.textContent = `${rec.direction} · ${GVL.fmtDur(rec.durationSec)} · auto-logged as ${GVL.label(rec.disposition)}`;
    const x = document.createElement('button');
    x.className = 'gvl-x';
    x.textContent = '✕';
    head.append(title, x);

    const grid = document.createElement('div');
    grid.className = 'gvl-grid';
    const notes = document.createElement('input');
    notes.placeholder = 'Note (optional)';
    notes.className = 'gvl-notes';

    let timer = setTimeout(() => root.remove(), settings.toastSec * 1000);
    const hold = () => clearTimeout(timer);
    root.addEventListener('mouseenter', hold);
    root.addEventListener('focusin', hold);

    x.onclick = async () => {
      if (notes.value.trim()) await GVL.updateCall(rec.id, { notes: notes.value.trim() });
      root.remove();
    };

    for (const [k, name] of GVL.DISPOSITIONS) {
      const b = document.createElement('button');
      b.textContent = name;
      if (k === rec.disposition) b.className = 'gvl-active';
      b.onclick = async () => {
        await GVL.updateCall(rec.id, { disposition: k, dispositionSource: 'agent', notes: notes.value.trim() });
        root.remove();
      };
      grid.appendChild(b);
    }
    root.append(head, sub, grid, notes);
    document.body.appendChild(root);
  }

  // ---- "Not signed in" reminder ----
  async function checkSession() {
    try {
      const { session } = await chrome.storage.local.get('session');
      let pill = document.getElementById('gvl-pill');
      if (!session) {
        if (!pill) {
          pill = document.createElement('div');
          pill.id = 'gvl-pill';
          pill.textContent = 'Voice Call Logger: not signed in. Click the extension icon to sign in.';
          document.body.appendChild(pill);
        }
      } else pill?.remove();
    } catch (e) { /* extension reloaded */ }
  }

  setInterval(tick, 1000);
  setInterval(ping, 20000);
  setInterval(checkSession, 5000);
  checkSession();
  ping();
})();
