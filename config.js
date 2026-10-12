// Fill these in from Supabase: Project Settings -> API
const CFG = {
  SUPABASE_URL: 'https://qtliugrxpapcgykigtij.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_jvTiLZKasv24W7-DPYCERA_JtnOLhFk', // the "anon public" key. Safe to ship; row-level security protects data.
  VOICEMAIL_MAX_SEC: 30, // connected calls this short are auto-guessed as voicemail
  TOAST_SEC: 20,         // how long the post-call correction panel stays up
  AUTO_NEXT_SEC: 8,      // auto-dialer: seconds the result panel stays up before the next number dials (hover to hold)
  DIAL_FALLBACK_RELOAD: true // if in-page dialing fails, fall back to Google's dial link (reloads the page)
};
