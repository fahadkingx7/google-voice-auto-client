// Service worker: login, token refresh, upload queue, heartbeat.
importScripts('config.js', 'shared.js');

const AUTH = CFG.SUPABASE_URL + '/auth/v1';
const REST = CFG.SUPABASE_URL + '/rest/v1';
const KEY = CFG.SUPABASE_ANON_KEY;
const HOST = (() => { try { return new URL(CFG.SUPABASE_URL).host; } catch (e) { return CFG.SUPABASE_URL; } })();
const NETWORK_HELP = `Can't reach ${HOST} (Failed to fetch). Your network, DNS or VPN may be blocking supabase.co, or the URL in config.js is wrong. Test: open ${CFG.SUPABASE_URL}/auth/v1/health in Chrome. A page with JSON means the network is fine; an error page means it is blocked.`;

function makeSession(j) {
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + j.expires_in,
    user: { id: j.user.id, email: j.user.email }
  };
}

async function authReq(grant, body) {
  const r = await fetch(`${AUTH}/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!r.ok) {
    const raw = j.error_description || j.msg || j.message || (typeof j.error === 'string' ? j.error : '') || text.slice(0, 160) || 'no response from server';
    const friendly = j.error_code === 'invalid_credentials' || /invalid login/i.test(raw)
      ? 'Wrong email or password, or this account has not been created yet.' : raw;
    const e = new Error(`${friendly} (HTTP ${r.status})`);
    e.status = r.status;
    throw e;
  }
  return j;
}

let refreshing = null;
async function getSession() {
  const { session } = await chrome.storage.local.get('session');
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const s = makeSession(await authReq('refresh_token', { refresh_token: session.refresh_token }));
        await chrome.storage.local.set({ session: s });
        return s;
      } catch (e) {
        if (e.status >= 400 && e.status < 500) await chrome.storage.local.remove('session'); // revoked / expired
        return null;
      }
    })().finally(() => (refreshing = null));
  }
  return refreshing;
}

const headers = s => ({ apikey: KEY, Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' });

function toRow(c, agentId) {
  return {
    id: c.id,
    agent_id: agentId,
    number: c.number,
    label: c.label || '',
    direction: c.direction || 'outgoing',
    started_at: new Date(c.startedAt).toISOString(),
    ended_at: new Date(c.endedAt || c.startedAt).toISOString(),
    duration_sec: c.durationSec || 0,
    auto_disposition: c.autoDisposition || c.disposition,
    disposition: c.disposition,
    disposition_source: c.dispositionSource || 'auto',
    notes: c.notes || '',
    lead_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.leadId || '') ? c.leadId : null,
    ended_by: c.endedBy || null
  };
}

let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const s = await getSession();
    if (!s) return;
    const dirty = (await GVL.getCalls()).filter(c => c.dirty);
    if (!dirty.length) return;
    const post = rows => fetch(REST + '/calls?on_conflict=id', {
      method: 'POST',
      headers: { ...headers(s), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    let rows = dirty.map(c => toRow(c, s.user.id));
    let r = await post(rows);
    if (r.status === 400) {
      // Most common cause: the database has not been upgraded yet (no ended_by column). Keep logging without it.
      const body = await r.clone().text().catch(() => '');
      if (/ended_by/i.test(body)) {
        rows = rows.map(({ ended_by, ...rest }) => rest);
        r = await post(rows);
      }
    }
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).slice(0, 160);
      let msg = body;
      try { const j = JSON.parse(body); msg = j.message || j.hint || body; } catch (e) { /* not JSON */ }
      await chrome.storage.local.set({ syncError: `Upload failed (${r.status}): ${msg || 'unknown'}. Will retry.` });
      return;
    }
    const sent = new Map(dirty.map(c => [c.id, c.rev]));
    const fresh = await GVL.getCalls();
    for (const c of fresh) if (sent.has(c.id) && c.rev === sent.get(c.id)) c.dirty = false;
    await chrome.storage.local.set({ calls: fresh, lastSync: Date.now(), syncError: '' });
  } catch (e) {
    await chrome.storage.local.set({ syncError: 'Offline? Will retry.' });
  } finally {
    syncing = false;
  }
}

// ---- dialer queue ----
async function countLeads(s, status) {
  const r = await fetch(`${REST}/leads?select=id,lead_lists!inner(enabled)&lead_lists.enabled=eq.true&agent_id=eq.${s.user.id}&status=eq.${status}`,
    { headers: { ...headers(s), Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '').split('/')[1], 10) || 0;
}
async function queueInfo() {
  const s = await getSession();
  if (!s) throw new Error('Not signed in');
  const r = await fetch(`${REST}/leads?select=id,number,name,company,notes,lead_lists!inner(enabled)&lead_lists.enabled=eq.true&agent_id=eq.${s.user.id}&status=eq.pending&order=position.asc,id.asc&limit=1`, { headers: headers(s) });
  if (!r.ok) throw new Error(`Queue request failed (${r.status})`);
  const next = (await r.json())[0] || null;
  const [pending, called] = await Promise.all([countLeads(s, 'pending'), countLeads(s, 'called')]);
  return { next, pending, called };
}
async function leadUpdate(id, status) {
  const s = await getSession();
  if (!s) throw new Error('Not signed in');
  const r = await fetch(`${REST}/leads?id=eq.${id}&agent_id=eq.${s.user.id}`, {
    method: 'PATCH', headers: { ...headers(s), Prefer: 'return=minimal' },
    body: JSON.stringify({ status, called_at: new Date().toISOString() })
  });
  if (!r.ok) throw new Error(`Could not update lead (${r.status})`);
}

// The agent's whole list (enabled lists only), for the "My list" tab.
async function myLeads() {
  const s = await getSession();
  if (!s) throw new Error('Not signed in');
  const out = [];
  for (let off = 0; off < 20000; off += 1000) {
    const r = await fetch(`${REST}/leads?select=id,number,name,company,notes,status,attempts,last_disposition,last_call_at,position,lead_lists!inner(name,enabled)&lead_lists.enabled=eq.true&agent_id=eq.${s.user.id}&order=position.asc,id.asc&limit=1000&offset=${off}`, { headers: headers(s) });
    if (!r.ok) throw new Error(`Could not load your list (${r.status})`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
// Put numbers back in the auto-dial queue.
async function requeue(ids) {
  const s = await getSession();
  if (!s) throw new Error('Not signed in');
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(x => String(x).replace(/[^0-9a-f-]/gi, ''));
    const r = await fetch(`${REST}/leads?id=in.(${chunk.join(',')})&agent_id=eq.${s.user.id}`, {
      method: 'PATCH', headers: { ...headers(s), Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'pending', called_at: null })
    });
    if (!r.ok) throw new Error(`Could not re-queue (${r.status})`);
  }
}

async function heartbeat(onCall, number) {
  const s = await getSession();
  if (!s) return;
  await fetch(REST + '/rpc/heartbeat', {
    method: 'POST',
    headers: headers(s),
    body: JSON.stringify({ p_on_call: !!onCall, p_number: number || null })
  });
}

async function login(email, password) {
  const j = await authReq('password', { email, password });
  const s = makeSession(j);
  const { lastUserId } = await chrome.storage.local.get('lastUserId');
  // Different person on a shared browser: never upload someone else's leftovers.
  if (lastUserId && lastUserId !== s.user.id) await chrome.storage.local.remove(['calls', 'lastSync', 'syncError']);
  await chrome.storage.local.set({ session: s, lastUserId: s.user.id });
  sync();
  return s.user;
}

async function logout() {
  await sync();
  const pending = (await GVL.getCalls()).filter(c => c.dirty).length;
  if (pending) throw new Error(`${pending} call(s) haven't uploaded yet. Check your connection and try again.`);
  await chrome.storage.local.remove(['session', 'calls', 'lastSync', 'syncError']);
}

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  (async () => {
    try {
      if (msg.type === 'login') send({ ok: true, user: await login(msg.email, msg.password) });
      else if (msg.type === 'logout') { await logout(); send({ ok: true }); }
      else if (msg.type === 'heartbeat') { await heartbeat(msg.onCall, msg.number); send({ ok: true }); }
      else if (msg.type === 'queue') send({ ok: true, data: await queueInfo() });
      else if (msg.type === 'myLeads') send({ ok: true, data: await myLeads() });
      else if (msg.type === 'requeue') { await requeue(msg.ids || []); send({ ok: true }); }
      else if (msg.type === 'leadDone') { await leadUpdate(msg.id, 'called'); send({ ok: true }); }
      else if (msg.type === 'leadSkip') { await leadUpdate(msg.id, 'skipped'); send({ ok: true }); }
      else if (msg.type === 'sync') { await sync(); send({ ok: true }); }
      else send({ ok: false });
    } catch (e) {
      send({ ok: false, error: e instanceof TypeError ? NETWORK_HELP : (e.message || String(e)) });
    }
  })();
  return true;
});

chrome.storage.onChanged.addListener(ch => { if (ch.calls) sync(); });
chrome.alarms.create('sync', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'sync') sync(); });
chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(sync);
