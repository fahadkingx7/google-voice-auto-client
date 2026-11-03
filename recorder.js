// Runs inside the Google Voice page itself (not the extension's sandbox), from the moment the page starts loading,
// so it can see the browser-calling connection Google Voice opens for each call.
// When content.js says a call started, it records:
//   mix    - both sides together (this is what admins listen to)
//   agent  - only the agent's microphone      } used to label who said what in the transcript
//   caller - only the other person            }
// Nothing leaves the page from here: the audio is handed to content.js, which uploads it.
(() => {
  if (window.__gvlRecorder) return;
  window.__gvlRecorder = true;

  const Native = window.RTCPeerConnection;
  if (!Native) return;
  const pcs = new Set();
  function Wrapped(...args) {
    const pc = new Native(...args);
    pcs.add(pc);
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'closed') pcs.delete(pc); });
    return pc;
  }
  Wrapped.prototype = Native.prototype;
  Object.setPrototypeOf(Wrapped, Native);
  try { window.RTCPeerConnection = Wrapped; if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped; } catch (e) { return; }

  const ORIGIN = 'https://voice.google.com';
  const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  let rec = null; // the current recording

  function liveTracks() {
    const mine = [], theirs = [];
    for (const pc of pcs) {
      if (pc.connectionState === 'closed') continue;
      try { for (const s of pc.getSenders()) if (s.track && s.track.kind === 'audio' && s.track.readyState === 'live') mine.push(s.track); } catch (e) { /* closed */ }
      try { for (const r of pc.getReceivers()) if (r.track && r.track.kind === 'audio' && r.track.readyState === 'live') theirs.push(r.track); } catch (e) { /* closed */ }
    }
    return { mine, theirs };
  }

  // Ringing on the line is a steady pure tone (US ringback: 440 + 480 Hz); a voice is spread across many
  // frequencies. The recording starts when the other side sounds like a voice, not when the line connects.
  const PRE_ROLL = 1.0; // seconds kept from just before the voice was heard (so "Hello?" isn't cut)
  function voiceLevel(an, fbuf, tbuf) {
    an.getFloatTimeDomainData(tbuf);
    let sum = 0; for (let i = 0; i < tbuf.length; i++) sum += tbuf[i] * tbuf[i];
    const rms = Math.sqrt(sum / tbuf.length);
    an.getFloatFrequencyData(fbuf);
    const hz = an.context.sampleRate / an.fftSize, lo = Math.floor(250 / hz), hi = Math.ceil(3500 / hz);
    const pw = []; let tot = 0;
    for (let i = lo; i <= hi && i < fbuf.length; i++) { const p = Math.pow(10, fbuf[i] / 10); pw.push(p); tot += p; }
    pw.sort((x, y) => y - x);
    const top = pw.slice(0, 8).reduce((x, y) => x + y, 0);
    return { rms, tonal: tot > 0 && top / tot > 0.55 };
  }

  function start(key) {
    if (rec) stopNow(); // a leftover recording from a call we missed the end of
    if (!MIME) return;
    let ctx;
    try { ctx = new AudioContext(); } catch (e) { return; }
    const dest = () => { const d = ctx.createMediaStreamDestination(); d.channelCount = 1; return d; };
    // One recording of both sides. Who is talking is worked out from the two volume levels below, so the call only
    // needs to be transcribed once (half the cost of transcribing each side separately).
    const out = { mix: dest() };
    // Everything reaches the recorders one second late, so starting them at "voice heard" still includes that second.
    const delay = {};
    for (const k of Object.keys(out)) { delay[k] = ctx.createDelay(PRE_ROLL + 0.5); delay[k].delayTime.value = PRE_ROLL; delay[k].connect(out[k]); }
    // A silent signal keeps every recording's timeline continuous (otherwise quiet stretches get squeezed out
    // and the agent's and caller's lines would no longer line up in the transcript).
    try { const keep = ctx.createConstantSource(); keep.offset.value = 0; for (const d of Object.values(out)) keep.connect(d); keep.start(); } catch (e) { /* older browser */ }
    const ear = { caller: ctx.createAnalyser(), agent: ctx.createAnalyser() };
    for (const a of Object.values(ear)) { a.fftSize = 2048; a.smoothingTimeConstant = 0.2; }
    const fbuf = new Float32Array(1024), tbuf = new Float32Array(2048);
    const recorders = {}, chunks = { mix: [] };
    const seen = new Set();
    const attach = () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const { mine, theirs } = liveTracks();
      for (const [list, side] of [[mine, 'agent'], [theirs, 'caller']]) for (const t of list) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        try {
          // Chrome only feeds a call's incoming audio to the recorder while it's attached to a (here: muted) audio element.
          if (side === 'caller') { const el = new Audio(); el.muted = true; el.srcObject = new MediaStream([t]); el.play().catch(() => {}); rec.els.push(el); }
          const src = ctx.createMediaStreamSource(new MediaStream([t]));
          src.connect(delay.mix); src.connect(ear[side]);
          rec.found[side] = true;
        } catch (e) { /* track not usable */ }
      }
    };
    const begin = () => {
      if (rec.picked) return;
      rec.picked = true; rec.pickedAt = Date.now();
      for (const k of Object.keys(out)) {
        try {
          const r = new MediaRecorder(out[k].stream, { mimeType: MIME, audioBitsPerSecond: 32000 });
          r.ondataavailable = e => { if (e.data && e.data.size) chunks[k].push(e.data); };
          r.start(1000);
          recorders[k] = r;
        } catch (e) { /* skip this one */ }
      }
      tell({ __gvlRecState: 'recording', key });
    };
    let callerVoice = 0, agentVoice = 0;
    const rms = an => { an.getFloatTimeDomainData(tbuf); let s2 = 0; for (let i = 0; i < tbuf.length; i++) s2 += tbuf[i] * tbuf[i]; return Math.sqrt(s2 / tbuf.length); };
    const listen = () => {
      if (!rec) return;
      // volume of each side, ten times a second: tells the transcript who said what
      rec.levels.push([Date.now(), rms(ear.agent), rms(ear.caller)]);
      if (rec.levels.length > 40 && !rec.picked) rec.levels.splice(0, rec.levels.length - 40); // before pickup only the last few seconds matter
      if (rec.picked) return;
      const c = voiceLevel(ear.caller, fbuf, tbuf);
      callerVoice = c.rms > 0.006 && !c.tonal ? callerVoice + 1 : 0;
      const g = voiceLevel(ear.agent, fbuf, tbuf);
      agentVoice = g.rms > 0.02 && !g.tonal ? agentVoice + 1 : Math.max(0, agentVoice - 1);
      // the other side speaks for ~0.3 s, or (if they picked up silently) the agent talks for ~1.5 s after the line connected
      if (callerVoice >= 3 || (agentVoice >= 15 && Date.now() - rec.startedAt > 3000)) begin();
    };
    rec = { key, ctx, recorders, chunks, found: { agent: false, caller: false }, picked: false, pickedAt: 0, startedAt: Date.now(), timer: null, ear: null, els: [], levels: [] };
    attach();
    rec.timer = setInterval(attach, 500); // the call's audio appears a moment after the call starts
    rec.ear = setInterval(listen, 100);
  }

  async function stopNow() {
    const r = rec; rec = null;
    if (!r) return null;
    clearInterval(r.timer); clearInterval(r.ear);
    if (r.picked) await new Promise(s => setTimeout(s, (PRE_ROLL + 0.2) * 1000)); // let the delayed last second reach the recorders
    await Promise.all(Object.values(r.recorders).map(m => new Promise(res => {
      if (m.state === 'inactive') return res();
      m.onstop = res; try { m.stop(); } catch (e) { res(); }
    })));
    for (const el of r.els) { try { el.srcObject = null; } catch (e) { /* gone */ } }
    try { r.ctx.close(); } catch (e) { /* already closed */ }
    const blob = k => new Blob(r.chunks[k], { type: MIME.split(';')[0] });
    // Volume timeline in recording time (the recording starts PRE_ROLL before the voice was heard), 0.2 s steps:
    // [seconds, agent level, caller level] with levels as whole numbers (rms × 1000).
    const levels = [];
    if (r.picked) {
      const base = r.pickedAt - PRE_ROLL * 1000, bins = new Map();
      for (const [ts, a, c] of r.levels) {
        if (ts < base) continue;
        const k = Math.floor((ts - base) / 200);
        const b = bins.get(k) || [0, 0, 0]; b[0] += a; b[1] += c; b[2]++; bins.set(k, b);
      }
      for (const [k, [a, c, n]] of [...bins].sort((x, y) => x[0] - y[0])) levels.push([+(k * 0.2).toFixed(1), Math.round(a / n * 1000), Math.round(c / n * 1000)]);
    }
    return { key: r.key, found: r.found, picked: r.picked, ms: r.picked ? Date.now() - r.pickedAt : 0, mime: MIME, mix: blob('mix'), levels };
  }

  const tell = msg => { try { window.top.postMessage(msg, ORIGIN); } catch (e) { /* top went away */ } };

  window.addEventListener('message', async e => {
    if (e.origin !== ORIGIN || !e.data || !e.data.__gvlRec) return;
    const { __gvlRec: cmd, key } = e.data;
    if (cmd === 'start') start(key);
    else if (cmd === 'stop' && rec && rec.key === key) {
      const out = await stopNow();
      if (!out || !(out.found.agent || out.found.caller)) return; // this frame never saw the call's audio
      if (!out.picked) { tell({ __gvlRecData: true, key, found: out.found, picked: false, ms: 0 }); return; } // nobody picked up: nothing recorded
      tell({ __gvlRecData: true, key, found: out.found, picked: true, ms: out.ms, mime: out.mime, mix: await out.mix.arrayBuffer(), levels: out.levels });
    }
  });
})();
