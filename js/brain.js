// Tactic brain: estimates both teams' economy from the round history (CS2 MR12 money rules:
// $3250/$3500 round wins, loss bonus $1400-$3400 that drops by one step after a win, $800 for a
// T plant, $50 per T killed for every CT since the July 2025 update),
// recommends what to buy, and scores every tactic for the next round from economy fit, the
// enemy's likely buy, decayed history (per enemy economy when there's enough of it), how this
// match is going and how predictable we've been. Deterministic, so all five pages agree.
import { team, KINDS, lineup } from './core.js';
import { SITES } from './mapdata.js';
import { placeAt } from './callouts.js';

export const TAGS = {
  T: { rush: 'Rush', execute: 'Wejście z utility', split: 'Split', default: 'Default', fake: 'Fake', slow: 'Wolna', contact: 'Contact', 'anti-eco': 'Na eco rywala' },
  CT: { default: 'Default', stack: 'Stack', aggressive: 'Agresywna', retake: 'Retake', passive: 'Pasywna', 'anti-eco': 'Na eco rywala' },
};

// --- economy ---

const WIN_REWARD = { elimination: 3250, time: 3250, bomb: 3500, defuse: 3500 };
const LOSS_BONUS = [1400, 1900, 2400, 2900, 3400];
const FULL = { T: 3900, CT: 4400 };   // rifle + armor + some utility, per player
const NADE_COST = { smoke: 300, flash: 200, molotov: 500, he: 300, decoy: 50 };
const flip = side => side === 'T' ? 'CT' : 'T';
const halfStart = r => r === 1 || r === 13 || (r > 24 && (r - 25) % 6 === 0);
const lastOfHalf = r => r === 12 || r === 24 || (r > 24 && (r - 24) % 3 === 0);
const money = n => `$${Math.round(n).toLocaleString('en-US')}`;

// Our side in round r, knowing the side of the round being played now.
function sideIn(r, ctx) {
  const half = x => (x <= 12 ? 0 : x <= 24 ? 1 : 2 + Math.floor((x - 25) / 3));
  return (half(r) - half(ctx.round)) % 2 === 0 ? ctx.side : flip(ctx.side);
}

function decide(t, r, side) {
  if (r === 1 || r === 13) return 'pistol';
  const have = t.m + t.carry;
  if (have >= FULL[side]) return 'full';
  if (lastOfHalf(r)) return 'force';                                   // money resets anyway
  if (t.m + 200 + LOSS_BONUS[Math.min(4, t.lc + 1)] >= FULL[side]) return 'eco'; // save now, full next
  if (have >= 2300) return 'force';
  return 'eco';
}

function spend(t, cat, side) {
  const s = { pistol: 650, full: FULL[side] - 400, force: Math.max(0, t.m - 250), eco: 150 }[cat];
  t.m = Math.max(0, t.m - Math.max(0, s - t.carry));
}

// Replays the match so far for both teams. Kill money is folded into a flat per-round amount.
export function economy(ctx, history) {
  const us = { m: 800, lc: 1, carry: 0, cat: null };
  const them = { m: 800, lc: 1, carry: 0, cat: null };
  for (let r = 1; r <= ctx.round; r++) {
    if (halfStart(r)) {
      const startMoney = r > 24 ? 10000 : 800;
      Object.assign(us, { m: startMoney, lc: 1, carry: 0 });
      Object.assign(them, { m: startMoney, lc: 1, carry: 0 });
    }
    const side = sideIn(r, ctx);
    us.cat = decide(us, r, side);
    them.cat = decide(them, r, flip(side));
    if (r === ctx.round) break;
    const h = history.find(x => x.round_no === r);
    if (!h || h.won == null) continue;
    spend(us, us.cat, side);
    spend(them, them.cat, flip(side));
    const reason = WIN_REWARD[h.reason] ? h.reason : 'elimination';
    const [win, lose, loseSide] = h.won ? [us, them, flip(side)] : [them, us, side];
    win.m += WIN_REWARD[reason] + 450;
    lose.m += LOSS_BONUS[lose.lc] + 200 + (loseSide === 'T' && reason === 'defuse' ? 800 : 0);
    // Since July 2025 every CT gets $50 per terrorist killed that round, win or lose. GSI doesn't
    // say how many died, so it's estimated from how the round ended.
    const ctWon = h.won === (side === 'CT');
    const tDeaths = ctWon ? { elimination: 5, defuse: 4, time: 3 }[reason] ?? 4 : 2;
    (side === 'CT' ? us : them).m += 50 * tDeaths;
    // Winners keep most of their guns; a saved rifle is worth a good part of the next buy.
    win.carry = win.cat === 'full' || win.cat === 'force' ? 1800 : 600;
    lose.carry = 0;
    win.lc = Math.max(0, win.lc - 1);
    lose.lc = Math.min(4, lose.lc + 1);
    us.m = Math.min(us.m, 16000);
    them.m = Math.min(them.m, 16000);
  }

  // Real money from GSI beats the simulation for our side.
  const r = ctx.round;
  const side = ctx.side;
  let rec = us.cat;
  const recWhy = [];
  if (ctx.econ === 'pistol' || r === 1 || r === 13) {
    rec = 'pistol';
    recWhy.push('runda pistoletowa');
  } else if (ctx.power != null) {
    rec = decide({ m: ctx.power, carry: 0, lc: us.lc }, r, side);
    recWhy.push(`macie śr. ${money(ctx.power)} na gracza (z GSI)`);
  } else {
    recWhy.push(`szacunek: ok. ${money(us.m + us.carry)} na gracza`);
  }
  if (rec === 'eco' && r !== 1 && r !== 13) recWhy.push(`oszczędzacie: po tej rundzie będzie na full buy`);
  if (rec === 'force' && lastOfHalf(r)) recWhy.push('ostatnia runda połowy, kasa i tak przepada');
  if (us.lc >= 2) recWhy.push(`bonus za przegraną ${money(LOSS_BONUS[us.lc])}`);

  const enemyWhy = [];
  const last = history.filter(x => x.won != null).at(-1);
  if (them.cat === 'pistol') enemyWhy.push('runda pistoletowa');
  else if ((r === 2 || r === 14) && last?.won) enemyWhy.push('przegrali pistolet');
  else if ((r === 2 || r === 14) && last && !last.won) enemyWhy.push('wygrali pistolet, mają pistolety i kasę');
  if (them.cat !== 'pistol') enemyWhy.push(`szacunek: ok. ${money(them.m + them.carry)} na gracza`);
  if (them.lc >= 3) enemyWhy.push(`duży bonus za przegrane (${money(LOSS_BONUS[them.lc])})`);

  return {
    rec, recWhy,
    enemy: them.cat, enemyWhy,
    us: { lossStreakBonus: LOSS_BONUS[us.lc], lc: us.lc },
    them: { money: them.m + them.carry, lc: them.lc },
  };
}

// --- tactic features ---

// Target site from the tactic, else from where its routes and grenades end up: the bombsite
// callout most of them land in, else the site nearest to their middle.
export function tacticSite(t) {
  if (t.site) return t.site;
  const sites = SITES[t.map];
  if (!sites) return null;
  const pts = [
    ...t.roles.map(r => r.path?.at(-1)).filter(Boolean),
    ...t.roles.flatMap(r => (r.lineups || []).map(lineup).filter(Boolean).map(l => l.spot?.to).filter(Boolean)),
  ];
  if (!pts.length) return null;
  const inSite = { A: 0, B: 0 };
  for (const p of pts) { const id = placeAt(t.map, p)?.id; if (id === 'BombsiteA') inSite.A++; if (id === 'BombsiteB') inSite.B++; }
  if (inSite.A !== inSite.B && Math.max(inSite.A, inSite.B) * 2 >= pts.length) return inSite.A > inSite.B ? 'A' : 'B';
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  const dist = s => Math.hypot(s.x - c.x, s.y - c.y);
  const [best] = Object.entries(sites).sort((a, b) => dist(a[1]) - dist(b[1]));
  return dist(best[1]) < 0.18 ? best[0] : 'mid';
}

export const utilityCost = t =>
  t.roles.flatMap(r => (r.lineups || []).map(lineup).filter(Boolean)).reduce((s, l) => s + (NADE_COST[l.nade] || 0), 0);

// Win/loss per tactic from past calls, older ones fading out (half weight after 30 days).
function learned(tacticId, enemy) {
  const now = Date.now();
  const all = (team.callHistory || []).filter(c => c.tactic_id === tacticId && c.won != null);
  const sum = list => list.reduce((acc, c) => {
    const w = 0.5 ** ((now - new Date(c.created_at).getTime()) / (30 * 864e5));
    acc.w += c.won ? w : 0;
    acc.n += w;
    return acc;
  }, { w: 0, n: 0 });
  const vsEnemy = enemy ? all.filter(c => c.enemy_econ === enemy) : [];
  return { all: sum(all), vs: sum(vsEnemy), rawN: all.length, rawW: all.filter(c => c.won).length, vsN: vsEnemy.length };
}

const KIND_RANK = { eco: 0, force: 1, full: 2 };

// --- scoring ---

export function suggest(ctx, history, model) {
  if (!ctx || !team.playbook) return [];
  const pool = team.playbook.tactics.filter(x => !x.archived && x.map === ctx.map && x.side === ctx.side);
  if (!pool.length) return [];
  const rec = model?.rec ?? ctx.econ;
  const enemy = model?.enemy;
  const played = history.filter(h => h.won != null);
  const last = played.at(-1);
  let lossStreak = 0;
  for (let i = played.length - 1; i >= 0 && played[i].won === false; i--) lossStreak++;
  const halfFrom = ctx.round <= 12 ? 1 : ctx.round <= 24 ? 13 : 25;
  const thisHalf = played.filter(h => h.round_no >= halfFrom);
  const siteOf = id => { const t = team.playbook.tactics.find(x => x.id === id); return t ? tacticSite(t) : null; };
  const lastSites = thisHalf.slice(-2).map(h => siteOf(h.tactic_id));
  const totalN = pool.reduce((s, t) => s + learned(t.id).all.n, 0);

  const scored = pool.map(t => {
    const tags = new Set(t.tags || []);
    const site = tacticSite(t);
    const parts = [];
    const add = (v, why) => { if (v) parts.push({ v, why }); };

    // 1. Our economy.
    if (rec === 'pistol' || t.kind === 'pistol') {
      add(rec === t.kind ? 60 : -80, rec === t.kind ? 'runda pistoletowa' : rec === 'pistol' ? 'to runda pistoletowa' : 'tylko na pistolet');
    } else if (t.kind === 'any') {
      add(18, null);
    } else if (rec && KIND_RANK[t.kind] != null) {
      if (t.kind === rec) add(45, `pasuje do zakupu (${KINDS[rec]})`);
      else if (KIND_RANK[t.kind] > KIND_RANK[rec]) add(-55, `za mało kasy (${KINDS[rec]})`);
      else add(-15, `stać was na więcej (${KINDS[rec]})`);
    }
    const cost = utilityCost(t);
    if (rec === 'eco' && cost > 700) add(-20, `utility za ${money(cost)} na eco`);

    // 2. What the enemy probably buys.
    if (enemy === 'eco' || enemy === 'force') {
      if (tags.has('anti-eco')) add(25, `rywal pewnie na ${enemy === 'eco' ? 'eco' : 'force'}`);
      if (ctx.side === 'T' && (tags.has('rush') || tags.has('contact'))) add(8, 'rywal słabo uzbrojony, można szybko');
      if (tags.has('slow') || tags.has('passive')) add(-10, 'na słaby zakup rywala lepiej grać agresywnie');
    } else if (enemy === 'full') {
      if (tags.has('anti-eco')) add(-15, 'rywal ma pełny zakup');
      if (ctx.side === 'T' && (tags.has('execute') || tags.has('split'))) add(8, 'na pełny zakup rywala: wejście z utility');
      if (ctx.side === 'T' && tags.has('rush') && rec !== 'eco') add(-6, 'rush na pełny zakup CT jest ryzykowny');
    }

    // 3. Learned value: decayed win rate (per enemy economy when there's enough data) + exploration.
    const L = learned(t.id, enemy);
    const base = L.vsN >= 3 ? L.vs : L.all;
    const mean = (base.w + 1) / (base.n + 2);
    const explore = 0.35 * Math.sqrt(Math.log(totalN + 2) / (L.all.n + 1));
    add(Math.round((mean + explore - 0.6) * 70),
      L.rawN ? `ogólnie ${L.rawW}/${L.rawN}${L.vsN >= 3 ? ` (na ${KINDS[enemy]} rywala ${Math.round(mean * 100)}%)` : ''}` : 'jeszcze nie grana, warto sprawdzić');

    // 4. This match.
    const used = played.filter(h => h.tactic_id === t.id);
    if (used.length) {
      const w = used.filter(h => h.won).length;
      add(w * 12 - (used.length - w) * 18, `w tym meczu ${w}/${used.length}`);
      if (used.length >= 3) add(-10 * (used.length - 2), 'mogli ją już rozczytać');
    }
    if (last?.tactic_id === t.id) add(last.won ? 8 : -30, last.won ? 'weszła w poprzedniej rundzie' : 'nie weszła w poprzedniej rundzie');
    if (lossStreak >= 2 && !used.length) add(15, `${lossStreak} przegrane z rzędu, czas na coś nowego`);

    // 5. Sites: predictability and how each site goes this half.
    if (site && site !== 'mid' && ctx.side === 'T') {
      if (lastSites.length === 2 && lastSites.every(s => s === site)) add(-15, `2 ostatnie rundy na ${site}, będą tam czekać`);
      const onSite = thisHalf.filter(h => siteOf(h.tactic_id) === site);
      const sw = onSite.filter(h => h.won).length;
      if (onSite.length >= 2 && sw === 0) add(-15, `na ${site} w tej połowie 0/${onSite.length}`);
      else if (onSite.length >= 2 && sw / onSite.length >= 0.67) add(8, `na ${site} idzie wam ${sw}/${onSite.length}`);
      if (lossStreak >= 1 && last && siteOf(last.tactic_id) && siteOf(last.tactic_id) !== site) add(6, `zmiana site'u po przegranej na ${siteOf(last.tactic_id)}`);
    }
    if (ctx.side === 'CT') {
      const plants = thisHalf.filter(h => !h.won && h.reason === 'bomb').length;
      if (plants >= 2 && (tags.has('retake') || tags.has('stack'))) add(12, `rywal ${plants}x wysadził bombę, trzeba stack lub retake`);
    }

    const score = parts.reduce((s, p) => s + p.v, 0);
    const why = parts.filter(p => p.why).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).map(p => p.why);
    return { tactic: t, score, why, site };
  }).sort((a, b) => b.score - a.score || a.tactic.name.localeCompare(b.tactic.name));

  // Confidence: a softmax over the scores, so "how much better than the rest".
  const ex = scored.map(s => Math.exp((s.score - scored[0].score) / 18));
  const total = ex.reduce((a, b) => a + b, 0);
  scored.forEach((s, i) => { s.confidence = Math.round(100 * ex[i] / total); });
  return scored;
}
