// Shared helpers (content script, popup, background)
const GVL = {
  DISPOSITIONS: [
    ['answered', 'Answered'],
    ['voicemail', 'Voicemail'],
    ['no_answer', 'No answer'],
    ['busy', 'Busy'],
    ['dead_number', 'Dead number'],
    ['failed', 'Call failed'],
    ['wrong_number', 'Wrong number'],
    ['missed', 'Missed (incoming)'],
    ['do_not_call', 'Do not call'],
    ['other', 'Other']
  ],
  DEFAULT_SETTINGS: { voicemailMaxSec: CFG.VOICEMAIL_MAX_SEC, toastSec: CFG.TOAST_SEC, promptEnabled: true },
  state: { call: null },
  actions: { endCall() { return false; }, debug() { return ''; } },
  hooks: { onCallStart() { return null; }, onCallRecorded() { return false; } },
  PHONE_RE: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,

  label(k) {
    const d = this.DISPOSITIONS.find(x => x[0] === k);
    return d ? d[1] : k;
  },
  fmtDur(s) {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
  },
  normalize(raw) {
    const digits = (raw || '').replace(/\D/g, '');
    if (digits.length < 7) return null;
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
    return '+' + digits;
  },
  extractNumber(text) {
    const m = (text || '').match(this.PHONE_RE);
    return m ? this.normalize(m[0]) : null;
  },
  async getSettings() {
    return { ...this.DEFAULT_SETTINGS };
  },
  async getCalls() {
    const r = await chrome.storage.local.get('calls');
    return r.calls || [];
  },
  // Every local write marks the record dirty so the background worker uploads it.
  async saveCall(rec) {
    const calls = await this.getCalls();
    calls.push({ ...rec, dirty: true, rev: 1 });
    await chrome.storage.local.set({ calls });
  },
  async updateCall(id, patch) {
    const calls = await this.getCalls();
    const i = calls.findIndex(c => c.id === id);
    if (i >= 0) {
      calls[i] = { ...calls[i], ...patch, dirty: true, rev: (calls[i].rev || 0) + 1 };
      await chrome.storage.local.set({ calls });
    }
  },
  uid() {
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  }
};
