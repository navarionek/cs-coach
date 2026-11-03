// Spoken calls in live mode, using the browser's own speech synthesis: Polish voice, free, works
// offline on PC and phones. Each call is read once; another call for the same round is a change.
import { store, KINDS, NADES, lineup } from './core.js';

export const voiceSupported = 'speechSynthesis' in window;
export const voice = { on: store.get('cs.voice') === '1', lastId: null, lastRound: null, lastMap: null };

let plVoice = null;
// Prefer the natural-sounding network voices (Google, Microsoft Online) when the system has them.
const pickVoice = () => {
  const vs = speechSynthesis.getVoices().filter(v => /^pl/i.test(v.lang));
  plVoice = vs.find(v => /google|natural|online/i.test(v.name)) || vs[0] || null;
};
if (voiceSupported) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

export function speak(text) {
  if (!voiceSupported || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pl-PL';
  if (plVoice) u.voice = plVoice;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

export function setVoice(on) {
  voice.on = on;
  store.set('cs.voice', on ? '1' : null);
  if (!on && voiceSupported) speechSynthesis.cancel();
}

const sentence = s => /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;

export function callText({ round, econ, tactic, role, changed = false }) {
  const parts = [changed ? `Zmiana! Runda ${round}.` : `Runda ${round}.`];
  if (econ && KINDS[econ] && econ !== 'any') parts.push(`${KINDS[econ]}.`);
  parts.push(`Gramy: ${sentence(tactic.name)}`);
  if (tactic.summary) parts.push(sentence(tactic.summary));
  if (role) {
    parts.push(`Ty: ${sentence(role.name || 'twoja rola')}`);
    if (role.position) parts.push(`Pozycja: ${sentence(role.position)}`);
    if (role.task) parts.push(sentence(role.task));
    const lus = (role.lineups || []).map(lineup).filter(Boolean);
    if (lus.length) parts.push(`Granaty: ${sentence(lus.map(l => `${NADES[l.nade]?.label || ''} ${l.title}`).join(', '))}`);
  }
  return parts.join(' ');
}

export function announce(ctx, call, tactic, role) {
  if (!voice.on || !call || !tactic || voice.lastId === call.id) return;
  const changed = voice.lastRound === ctx.round && voice.lastMap === ctx.map;
  Object.assign(voice, { lastId: call.id, lastRound: ctx.round, lastMap: ctx.map });
  speak(callText({ round: ctx.round, econ: ctx.econ, tactic, role, changed }));
}
