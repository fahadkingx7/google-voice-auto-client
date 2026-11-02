// Fill these in from Supabase: Project Settings -> API
const CFG = {
  SUPABASE_URL: 'https://qtliugrxpapcgykigtij.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_jvTiLZKasv24W7-DPYCERA_JtnOLhFk', // the "anon public" key. Safe to ship; row-level security protects data.
  VOICEMAIL_MAX_SEC: 30, // connected calls this short are auto-guessed as voicemail
  TOAST_SEC: 20,         // how long the post-call correction panel stays up
  SHOW_AUTO_TOGGLE: false, // set true to show the Auto-dial switch in the dialer
  AUTO_NEXT_SEC: 8,      // auto-dialer: seconds the result panel stays up before the next number dials (hover to hold)
  DIAL_FALLBACK_RELOAD: false, // true = if in-page dialing fails, retry with Google's dial link (reloads the page; can double-dial)
  REC_ENABLED: true,     // record calls and send them for a transcript (admins can listen in the portal)
  REC_URL: 'https://rec.trucksmate.com', // the recordings service (Cloudflare Worker)
  REC_URL_BACKUP: 'https://trucksmate-recordings.fahadkingx4.workers.dev', // same service, used if the main address can't be reached
  REC_MIN_SEC: 20        // only keep recordings of calls that talked at least this long (skips most voicemails)
};
