// Spoken calls in live mode. Default engine is the AI voice (ElevenLabs through the cs-tts edge
// function); the browser's own speech synthesis is the fallback and the free option.
// A call is spoken as short parts ("Runda 7.", "Full buy.", tactic + your role) so each AI clip is
// generated once and reused in every later round and match.
import { store, team, KINDS, NADES, lineup, SUPABASE_URL } from './core.js';

export const voiceSupported = 'speechSynthesis' in window || 'Audio' in window;
export const VOICE_OPTIONS = [
  ['ai:brian', 'AI · Brian'],
  ['ai:adam', 'AI · Adam'],
  ['ai:george', 'AI · George'],
  ['browser', 'Przeglądarka (bez AI)'],
];
export const voice = {
  on: store.get('cs.voice') === '1',
  engine: store.get('cs.voiceEngine') || 'ai:brian',
  lastId: null, lastRound: null, lastMap: null,
};

let plVoice = null;
// Prefer natural-sounding network voices (Google, Microsoft Online) when the system has them.
const pickVoice = () => {
  const vs = speechSynthesis.getVoices().filter(v => /^pl/i.test(v.lang));
  plVoice = vs.find(v => /google|natural|online/i.test(v.name)) || vs[0] || null;
};
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

function browserSay(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pl-PL';
  if (plVoice) u.voice = plVoice;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

async function clipUrl(text, name) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/cs-tts`, {
    method: 'POST',
    headers: { 'x-team-key': team.key, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: name }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.url) throw new Error(out.error || `HTTP ${res.status}`);
  return out.url;
}

let playing = null; // { cancelled, audio }
function stopAll() {
  if (playing) { playing.cancelled = true; playing.audio?.pause(); playing = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// Speaks the parts in order; AI clips are fetched in parallel, then played back to back.
export async function speak(parts) {
  parts = parts.filter(Boolean);
  if (!parts.length) return;
  stopAll();
  if (!voice.engine.startsWith('ai:')) { browserSay(parts.join(' ')); return; }
  const run = { cancelled: false, audio: null };
  playing = run;
  try {
    const urls = await Promise.all(parts.map(p => clipUrl(p, voice.engine.slice(3))));
    for (const url of urls) {
      if (run.cancelled) return;
      run.audio = new Audio(url);
      await new Promise((resolve, reject) => {
        run.audio.onended = resolve;
        run.audio.onerror = reject;
        run.audio.play().catch(reject);
      });
    }
  } catch (err) {
    console.warn('AI voice failed, using the browser voice', err);
    if (!run.cancelled) browserSay(parts.join(' '));
  } finally {
    if (playing === run) playing = null;
  }
}

export function setVoice(on) {
  voice.on = on;
  store.set('cs.voice', on ? '1' : null);
  if (!on) stopAll();
}

export function setEngine(engine) {
  voice.engine = engine;
  store.set('cs.voiceEngine', engine);
}

const sentence = s => /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;

// The tactic + role part; it doesn't mention the round, so its AI clip is reusable.
function coreText(tactic, role) {
  const parts = [`Gramy: ${sentence(tactic.name.replace(/^\[TEST\]\s*/, ''))}`];
  if (tactic.summary) parts.push(sentence(tactic.summary));
  if (role) {
    parts.push(`Ty: ${sentence(role.name || 'twoja rola')}`);
    if (role.position) parts.push(`Pozycja: ${sentence(role.position)}`);
    if (role.task) parts.push(sentence(role.task));
    const lus = (role.lineups || []).map(lineup).filter(Boolean);
    if (lus.length) parts.push(`Granaty: ${sentence(lus.map(l => `${NADES[l.nade]?.label || ''} ${l.title.replace(/^\[TEST\]\s*/, '')}`).join(', '))}`);
  }
  return parts.join(' ');
}

export function callParts({ round, econ, tactic, role, changed = false }) {
  return [
    `Runda ${round}.`,
    changed ? 'Zmiana taktyki!' : null,
    econ && KINDS[econ] && econ !== 'any' ? `${KINDS[econ]}.` : null,
    coreText(tactic, role),
  ];
}

export function announce(ctx, call, tactic, role) {
  if (!voice.on || !call || !tactic || voice.lastId === call.id) return;
  const changed = voice.lastRound === ctx.round && voice.lastMap === ctx.map;
  Object.assign(voice, { lastId: call.id, lastRound: ctx.round, lastMap: ctx.map });
  speak(callParts({ round: ctx.round, econ: ctx.econ, tactic, role, changed }));
}
