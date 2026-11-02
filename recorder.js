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

  function start(key) {
    if (rec) stopNow(); // a leftover recording from a call we missed the end of
    if (!MIME) return;
    let ctx;
    try { ctx = new AudioContext(); } catch (e) { return; }
    const dest = () => { const d = ctx.createMediaStreamDestination(); d.channelCount = 1; return d; };
    const out = { mix: dest(), agent: dest(), caller: dest() };
    // A silent signal keeps every recording's timeline continuous (otherwise quiet stretches get squeezed out
    // and the agent's and caller's lines would no longer line up in the transcript).
    try { const keep = ctx.createConstantSource(); keep.offset.value = 0; for (const d of Object.values(out)) keep.connect(d); keep.start(); } catch (e) { /* older browser */ }
    const recorders = {}, chunks = { mix: [], agent: [], caller: [] };
    for (const k of Object.keys(out)) {
      try {
        const r = new MediaRecorder(out[k].stream, { mimeType: MIME, audioBitsPerSecond: k === 'mix' ? 32000 : 24000 });
        r.ondataavailable = e => { if (e.data && e.data.size) chunks[k].push(e.data); };
        r.start(1000);
        recorders[k] = r;
      } catch (e) { /* skip this one */ }
    }
    const seen = new Set();
    const attach = () => {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const { mine, theirs } = liveTracks();
      for (const [list, side] of [[mine, 'agent'], [theirs, 'caller']]) for (const t of list) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        try {
          const src = ctx.createMediaStreamSource(new MediaStream([t]));
          src.connect(out.mix); src.connect(out[side]);
          rec.found[side] = true;
        } catch (e) { /* track not usable */ }
      }
    };
    rec = { key, ctx, recorders, chunks, found: { agent: false, caller: false }, startedAt: Date.now(), timer: null };
    attach();
    rec.timer = setInterval(attach, 500); // the call's audio appears a moment after the call starts
    tell({ __gvlRecState: 'recording', key });
  }

  async function stopNow() {
    const r = rec; rec = null;
    if (!r) return null;
    clearInterval(r.timer);
    await Promise.all(Object.values(r.recorders).map(m => new Promise(res => {
      if (m.state === 'inactive') return res();
      m.onstop = res; try { m.stop(); } catch (e) { res(); }
    })));
    try { r.ctx.close(); } catch (e) { /* already closed */ }
    const blob = k => new Blob(r.chunks[k], { type: MIME.split(';')[0] });
    return { key: r.key, found: r.found, ms: Date.now() - r.startedAt, mime: MIME, mix: blob('mix'), agent: blob('agent'), caller: blob('caller') };
  }

  const tell = msg => { try { window.top.postMessage(msg, ORIGIN); } catch (e) { /* top went away */ } };

  window.addEventListener('message', async e => {
    if (e.origin !== ORIGIN || !e.data || !e.data.__gvlRec) return;
    const { __gvlRec: cmd, key } = e.data;
    if (cmd === 'start') start(key);
    else if (cmd === 'stop' && rec && rec.key === key) {
      const out = await stopNow();
      if (!out || !(out.found.agent || out.found.caller)) return; // this frame never saw the call's audio
      const bufs = await Promise.all([out.mix, out.agent, out.caller].map(b => b.arrayBuffer()));
      tell({ __gvlRecData: true, key, found: out.found, ms: out.ms, mime: out.mime, mix: bufs[0], agent: bufs[1], caller: bufs[2] });
    }
  });
})();
