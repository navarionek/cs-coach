// Live mode: reads the team's GSI state, picks a tactic for the next round and shows every player
// their own role. Calls are shared through cs.calls + Realtime, so all five screens agree.
import {
  sb, team, rpc, esc, t, toast, openModal, mapName, money, KINDS, MAPS,
  segmented, bindSegmented, sideBadge, kindBadge, member, memberColor, tactic,
} from './core.js';
import { roleBlock, bindRoleLineups, recordText } from './tactics.js';

const POLL_MS = 3000;
const FRESH_MS = 90e3;          // GSI heartbeat is 60 s
const CALL_WINDOW_MS = 4 * 60e3; // a call belongs to its round for at most this long (matches cs.make_call)
const PHASES = {
  warmup: 'Rozgrzewka, plan na pistolet',
  freezetime: 'Kupowanie',
  live: 'Runda trwa',
  over: 'Koniec rundy, plan na następną',
  intermission: 'Przerwa, zmiana stron',
};
const REASON_ICONS = { elimination: '☠', bomb: '💣', defuse: '✂', time: '⏱' };

const L = {
  el: null, timer: null, channel: null, wake: null, polling: false, again: false,
  states: [], calls: [], match: null, rounds: [],
  practice: null, // {map, side, round, econ, us, them, history: [{round_no, won, tactic_id}], calls: {round: call}}
  autoCalling: false, lastCallId: null, sigMain: null, sigEcon: null,
};

const flip = side => side === 'T' ? 'CT' : 'T';
// MR12: sides swap before round 13; overtime is MR3 with a swap inside every 6-round block.
const swapsBefore = round => round === 13 || (round > 24 && (round - 25) % 6 === 3);

function econClass(power, side) {
  if (power == null) return null;
  if (power >= (side === 'CT' ? 4900 : 4700)) return 'full';
  if (power >= 2200) return 'force';
  return 'eco';
}

function freshStates() {
  const now = Date.now();
  const linked = new Set(team.playbook.members.map(m => m.steamid).filter(Boolean));
  return L.states.filter(s =>
    now - t(s.received_at) < FRESH_MS && s.state?.map?.name && s.state.map.phase !== 'gameover'
    && (!linked.size || linked.has(s.steamid)));
}

function gameContext() {
  if (L.practice) {
    const p = L.practice;
    return { ...p, practice: true, phase: 'freezetime', players: [], econ: p.round === 1 || p.round === 13 ? 'pistol' : p.econ };
  }
  const fresh = freshStates();
  const mine = fresh.find(s => s.steamid === member(team.me)?.steamid) || fresh[0];
  if (!mine) return null;
  const st = mine.state;
  const map = st.map.name;
  const same = fresh.filter(s => s.state.map.name === map);
  const own = s => s.state.player?.steamid === s.steamid ? s.state.player : null;
  const sideNow = own(mine)?.team || same.map(own).find(Boolean)?.team || st.player?.team || 'T';
  const ct = st.map.team_ct?.score ?? 0, tt = st.map.team_t?.score ?? 0;
  const round = ct + tt + 1;
  const phase = st.map.phase === 'live' ? (st.round?.phase || 'live') : st.map.phase;
  // After the last round of a half the score already counts it, but sides swap only at freezetime.
  const side = phase === 'over' && swapsBefore(round) ? flip(sideNow) : sideNow;

  const players = team.playbook.members.filter(m => m.steamid).map(m => {
    const s = same.find(x => x.steamid === m.steamid);
    const p = s && own(s);
    return {
      member: m,
      online: !!s,
      money: p?.state?.money ?? null,
      equip: p?.state?.equip_value ?? null,
      hp: p?.state?.health ?? null,
    };
  });
  const known = players.filter(p => p.money != null);
  const power = known.length ? known.reduce((s, p) => s + p.money + (p.equip || 0), 0) / known.length : null;
  const econ = round === 1 || round === 13 ? 'pistol' : econClass(power, side);
  return {
    practice: false, map, side, round, phase,
    us: sideNow === 'T' ? tt : ct, them: sideNow === 'T' ? ct : tt,
    players, power, econ,
  };
}

function callFor(ctx) {
  if (!ctx) return null;
  if (ctx.practice) return L.practice.calls[ctx.round] || null;
  const now = Date.now();
  const c = L.calls
    .filter(c => c.map === ctx.map && c.round_no === ctx.round && now - t(c.created_at) < CALL_WINDOW_MS)
    .sort((a, b) => t(b.created_at) - t(a.created_at))[0];
  return c && c.side === ctx.side ? c : null;
}

// This match's finished rounds with the tactic that was called for each.
function matchHistory(ctx) {
  if (!ctx) return [];
  if (ctx.practice) return L.practice.history;
  if (!L.match) return [];
  const since = t(L.match.started_at) - 60e3;
  return L.rounds.map(r => {
    const c = L.calls.filter(c => c.map === ctx.map && c.round_no === r.round_no && t(c.created_at) >= since)
      .sort((a, b) => t(b.created_at) - t(a.created_at))[0];
    return { round_no: r.round_no, won: r.won, tactic_id: c?.tactic_id || null, reason: (r.win_reason || '').replace(/^(ct|t)_win_/, '') };
  });
}

const KIND_RANK = { eco: 0, force: 1, full: 2 };

// Scores every active tactic for this map/side. Deterministic, so all five pages agree.
export function suggest(ctx, history) {
  if (!ctx) return [];
  const pool = team.playbook.tactics.filter(x => !x.archived && x.map === ctx.map && x.side === ctx.side);
  const last = history.at(-1);
  let lossStreak = 0;
  for (let i = history.length - 1; i >= 0 && history[i].won === false; i--) lossStreak++;

  return pool.map(x => {
    let score = 0;
    const why = [];
    if (ctx.econ === 'pistol' || x.kind === 'pistol') {
      if (ctx.econ === x.kind) { score += 60; why.push('runda pistoletowa'); }
      else { score -= 80; why.push(ctx.econ === 'pistol' ? 'to runda pistoletowa' : 'tylko na pistolet'); }
    } else if (x.kind === 'any') {
      score += 20;
    } else if (!ctx.econ) {
      score += 10;
    } else if (x.kind === ctx.econ) {
      score += 50; why.push(`pasuje do kasy (${KINDS[ctx.econ]})`);
    } else if (KIND_RANK[x.kind] > KIND_RANK[ctx.econ]) {
      score -= 60; why.push(`za mało kasy (macie na ${KINDS[ctx.econ]})`);
    } else {
      score -= 15; why.push(`stać was na więcej (${KINDS[ctx.econ]})`);
    }

    const s = team.callStats[x.id];
    if (s?.n) {
      score += Math.round(((s.w + 1) / (s.n + 2) - 0.5) * 60);
      why.push(`ogólnie ${recordText(x.id)}`);
    } else {
      score += 5; why.push('jeszcze nie grana');
    }

    const used = history.filter(h => h.tactic_id === x.id);
    if (used.length) {
      const w = used.filter(h => h.won).length;
      score += w * 12 - (used.length - w) * 18;
      why.push(`w tym meczu ${w}/${used.length}`);
      if (used.length >= 3) { score -= 10 * (used.length - 2); why.push('mogli ją już rozczytać'); }
    }
    if (last?.tactic_id === x.id) {
      if (last.won) { score += 8; why.push('weszła w poprzedniej rundzie'); }
      else { score -= 30; why.push('nie weszła w poprzedniej rundzie'); }
    }
    if (lossStreak >= 2 && !used.length) { score += 15; why.push(`${lossStreak} przegrane z rzędu, pora coś zmienić`); }
    return { tactic: x, score, why };
  }).sort((a, b) => b.score - a.score || a.tactic.name.localeCompare(b.tactic.name));
}

async function poll() {
  if (L.polling) { L.again = true; return; }
  L.polling = true;
  try {
    const since = new Date(Date.now() - 3 * 3600e3).toISOString();
    const [live, calls] = await Promise.all([
      sb.from('live').select('steamid,received_at,state'),
      sb.from('calls').select('*').gte('created_at', since).order('created_at'),
    ]);
    if (!live.error) L.states = live.data;
    if (!calls.error) L.calls = calls.data;

    const fresh = freshStates();
    const map = fresh[0]?.state.map.name;
    if (map) {
      const ids = fresh.map(s => s.steamid);
      const { data: ms } = await sb.from('matches').select('id,started_at,map,steamid')
        .eq('map', map).eq('status', 'live').in('steamid', ids).order('last_update', { ascending: false }).limit(1);
      L.match = ms?.[0] || null;
      if (L.match) {
        const { data: rs } = await sb.from('rounds').select('round_no,won,win_reason').eq('match_id', L.match.id).order('round_no');
        L.rounds = rs || [];
      }
    } else {
      L.match = null;
      L.rounds = [];
    }
    draw();
    maybeAutoCall();
  } finally {
    L.polling = false;
    if (L.again) { L.again = false; poll(); }
  }
}

// Nobody called this round yet: put our top suggestion in. A short random delay keeps the five
// pages from racing; cs.make_call keeps whichever auto call lands first.
function maybeAutoCall() {
  const ctx = gameContext();
  if (!ctx || ctx.practice || L.autoCalling) return;
  if (!['warmup', 'freezetime', 'over', 'intermission'].includes(ctx.phase)) return;
  if (callFor(ctx)) return;
  const top = suggest(ctx, matchHistory(ctx))[0];
  if (!top) return;
  L.autoCalling = true;
  setTimeout(async () => {
    try {
      const again = gameContext();
      if (again && again.round === ctx.round && !callFor(again)) {
        await rpc('make_call', { p_map: ctx.map, p_side: ctx.side, p_round: ctx.round, p_tactic: top.tactic.id, p_by: team.me, p_auto: true });
        await poll();
      }
    } catch (err) {
      console.warn('auto call failed', err);
    } finally {
      L.autoCalling = false;
    }
  }, Math.random() * 1500);
}

async function callTactic(tacticId) {
  const ctx = gameContext();
  if (!ctx) return;
  if (ctx.practice) {
    L.practice.calls[ctx.round] = { id: `p${Date.now()}`, tactic_id: tacticId, side: ctx.side, called_by: team.me, auto: false };
    draw(true);
    return;
  }
  try {
    await rpc('make_call', { p_map: ctx.map, p_side: ctx.side, p_round: ctx.round, p_tactic: tacticId, p_by: team.me, p_auto: false });
    await poll();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function drawEcon(ctx) {
  const el = L.el.querySelector('.econ');
  if (!el) return;
  const sig = JSON.stringify(ctx?.players?.map(p => [p.member.id, p.online, p.money, p.equip, p.hp]) || []) + ctx?.econ;
  if (sig === L.sigEcon) return;
  L.sigEcon = sig;
  if (!ctx || ctx.practice || !ctx.players.length) { el.innerHTML = ''; return; }
  el.innerHTML = ctx.players.map(p => `
    <div class="eco-p ${p.online ? '' : 'off'} ${p.hp === 0 ? 'dead' : ''}" style="--c:${esc(memberColor(p.member))}">
      <b>${esc(p.member.name)}</b>
      <span>${p.online ? money(p.money) : 'offline'}</span>
      ${p.online && p.equip != null ? `<span class="muted small">sprzęt ${money(p.equip)}</span>` : ''}
      ${p.online && p.hp != null ? `<span class="hp">${p.hp > 0 ? `${p.hp} HP` : '☠'}</span>` : ''}
    </div>`).join('') + `<div class="eco-sum">${ctx.econ ? kindBadge(ctx.econ) : '<span class="muted small">ekonomia nieznana</span>'}
      ${ctx.power != null ? `<span class="muted small">śr. ${money(Math.round(ctx.power))} na gracza</span>` : ''}</div>`;
}

function draw(force = false) {
  if (!L.el || !team.playbook) return;
  const ctx = gameContext();
  const history = matchHistory(ctx);
  const sugg = suggest(ctx, history);
  const call = callFor(ctx);
  const x = call && tactic(call.tactic_id);
  const sig = JSON.stringify([ctx && { ...ctx, players: null, power: null }, call?.id, history, sugg.map(s => [s.tactic.id, s.score]), team.me, team.playbook.tactics.length, team.playbook.lineups.length]);
  if (!force && sig === L.sigMain) { drawEcon(ctx); return; }
  L.sigMain = sig;
  L.sigEcon = null;

  const newCall = call && call.id !== L.lastCallId;
  if (newCall && L.lastCallId !== null) navigator.vibrate?.([120, 60, 120]);
  L.lastCallId = call?.id || null;

  if (!ctx) {
    L.el.innerHTML = idleView();
    bindIdle();
    return;
  }

  const myRole = x?.roles.find(r => r.member_id === team.me);
  const others = x ? x.roles.filter(r => r !== myRole) : [];
  const caller = call && member(call.called_by);

  L.el.innerHTML = `
    <div class="card live-head">
      <div class="lh-map map-${esc(ctx.map)}">${esc(mapName(ctx.map))}</div>
      <div class="lh-mid">
        <div class="lh-round">Runda ${ctx.round}</div>
        <div class="muted small">${ctx.practice ? 'Trening' : esc(PHASES[ctx.phase] || ctx.phase)}</div>
      </div>
      <div class="lh-score"><span class="us">${ctx.us}</span><span class="sep">:</span><span>${ctx.them}</span></div>
      ${sideBadge(ctx.side)}
      ${ctx.practice ? `<div class="practice-bar">
        ${segmented('psid', [['T', 'T'], ['CT', 'CT']], ctx.side)}
        ${segmented('pecon', [['eco', 'Eco'], ['force', 'Force'], ['full', 'Full']], L.practice.econ)}
        <button type="button" class="btn small win" data-res="1">✓ Wygrana</button>
        <button type="button" class="btn small loss" data-res="0">✗ Przegrana</button>
        <button type="button" class="btn small ghost" data-act="end-practice">Zakończ</button>
      </div>` : ''}
    </div>
    <div class="econ"></div>
    <div class="live-grid">
      <section class="card call ${newCall ? 'pop' : ''}">
        <div class="call-label">TAKTYKA NA RUNDĘ ${ctx.round} ${ctx.econ ? kindBadge(ctx.econ) : ''}</div>
        ${x ? `
          <h2>${esc(x.name)}</h2>
          ${x.summary ? `<p class="lead">${esc(x.summary)}</p>` : ''}
          ${x.notes ? `<p class="notes">${esc(x.notes)}</p>` : ''}
          <div class="muted small">${call.auto ? '🤖 wybrana automatycznie' : `📣 call: ${esc(caller?.name || '?')}`} · ${recordText(x.id)}</div>`
        : sugg.length ? '<h2 class="muted">Wybieram taktykę…</h2>'
        : `<h2 class="muted">Brak taktyk na ${esc(mapName(ctx.map))} jako ${ctx.side}</h2><p class="muted">Dodaj je w zakładce Taktyki.</p>`}
        ${sugg.length ? '<button type="button" class="btn" data-act="change">Zmień taktykę</button>' : ''}
      </section>
      <section class="card mytask">
        <div class="call-label">TWOJE ZADANIE</div>
        ${myRole ? roleBlock(myRole, { mine: true, big: true })
          : x ? '<p class="muted">Nie masz przypisanej roli w tej taktyce. Zobacz role poniżej i weź wolną.</p>'
          : '<p class="muted">Pojawi się, jak będzie wybrana taktyka.</p>'}
      </section>
      ${others.length ? `<section class="card roles-live"><div class="call-label">RESZTA DRUŻYNY</div><div class="roles-grid">${others.map(r => roleBlock(r)).join('')}</div></section>` : ''}
      ${sugg.length ? `<section class="card sugg">
        <div class="call-label">PROPOZYCJE</div>
        ${sugg.slice(0, 3).map((s, i) => suggRow(s, i, call)).join('')}
      </section>` : ''}
      ${history.length ? `<section class="card hist">
        <div class="call-label">TEN MECZ</div>
        <div class="hist-row">${history.map(h => `<div class="h-chip ${h.won === true ? 'w' : h.won === false ? 'l' : ''}" title="${esc(tactic(h.tactic_id)?.name || 'bez taktyki')}">
          <span class="no">${h.round_no}</span>${h.reason ? `<span>${REASON_ICONS[h.reason] || ''}</span>` : ''}<span class="tn">${esc(tactic(h.tactic_id)?.name || '–')}</span></div>`).join('')}</div>
      </section>` : ''}
    </div>`;

  drawEcon(ctx);
  bindRoleLineups(L.el, { gallery: true });
  L.el.querySelector('[data-act="change"]')?.addEventListener('click', () => openPicker(ctx, sugg));
  L.el.querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => callTactic(b.dataset.play)));
  if (ctx.practice) bindPractice();
}

function suggRow(s, i, call) {
  const current = call?.tactic_id === s.tactic.id;
  return `<div class="sugg-row ${current ? 'current' : ''}">
    <div class="sugg-rank">${i + 1}</div>
    <div class="sugg-main">
      <div><b>${esc(s.tactic.name)}</b> ${kindBadge(s.tactic.kind)}</div>
      <div class="muted small">${s.why.slice(0, 3).map(esc).join(' · ')}</div>
    </div>
    ${current ? '<span class="muted small">gramy to</span>' : `<button type="button" class="btn small" data-play="${esc(s.tactic.id)}">Zagraj</button>`}
  </div>`;
}

function openPicker(ctx, sugg) {
  const call = callFor(ctx);
  const { el, close } = openModal(`
    <div class="picker">
      <h2>Taktyka na rundę ${ctx.round}</h2>
      <p class="muted">${esc(mapName(ctx.map))} · ${ctx.side} · ${ctx.econ ? esc(KINDS[ctx.econ]) : 'ekonomia nieznana'}. Twój wybór od razu zobaczy cała drużyna.</p>
      <div class="sugg-list">${sugg.map((s, i) => suggRow(s, i, call)).join('')}</div>
    </div>`, { wide: true });
  el.querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', async () => {
    close();
    await callTactic(b.dataset.play);
  }));
}

function idleView() {
  const p = { map: MAPS[0].id, side: 'T' };
  return `<div class="card idle">
    <div class="gate-ico">🎮</div>
    <h2>Nikt z drużyny nie gra teraz</h2>
    <p class="muted">Jak tylko ktoś z was wejdzie do meczu (z plikiem cfg), tu pojawi się mapa, wynik, kasa całej piątki i taktyka na kolejną rundę. Zostaw tę kartę otwartą na telefonie albo drugim monitorze.</p>
    <h3>Trening</h3>
    <p class="muted small">Przećwicz taktyki bez gry: wybierz mapę i stronę, potem klikaj wynik rund i patrz, co proponuje system.</p>
    <div class="practice-start">
      ${segmented('pmap', MAPS.map(m => [m.id, m.name]), p.map)}
      ${segmented('pside', [['T', 'T'], ['CT', 'CT']], p.side)}
      <button type="button" class="btn primary" data-act="practice">Start treningu</button>
    </div>
  </div>`;
}

function bindIdle() {
  const pick = { map: MAPS[0].id, side: 'T' };
  const sel = (name, key) => bindSegmented(L.el, name, v => {
    pick[key] = v;
    L.el.querySelectorAll(`[data-seg="${name}"] button`).forEach(b => b.classList.toggle('on', b.dataset.v === v));
  });
  sel('pmap', 'map');
  sel('pside', 'side');
  L.el.querySelector('[data-act="practice"]').onclick = () => {
    L.practice = { map: pick.map, side: pick.side, round: 1, econ: 'full', us: 0, them: 0, history: [], calls: {} };
    draw(true);
  };
}

function bindPractice() {
  const p = L.practice;
  bindSegmented(L.el, 'psid', v => { p.side = v; draw(true); });
  bindSegmented(L.el, 'pecon', v => { p.econ = v; draw(true); });
  L.el.querySelector('[data-act="end-practice"]').onclick = () => { L.practice = null; draw(true); };
  L.el.querySelectorAll('[data-res]').forEach(b => b.onclick = () => {
    const won = b.dataset.res === '1';
    const c = p.calls[p.round] || (() => {
      const top = suggest(gameContext(), p.history)[0];
      return top && { tactic_id: top.tactic.id };
    })();
    p.history.push({ round_no: p.round, won, tactic_id: c?.tactic_id || null });
    won ? p.us++ : p.them++;
    p.round++;
    if (swapsBefore(p.round)) p.side = flip(p.side);
    draw(true);
  });
  // Practice has no shared call: show the top suggestion as the call.
  if (!p.calls[p.round]) {
    const top = suggest(gameContext(), p.history)[0];
    if (top) { p.calls[p.round] = { id: `p${Date.now()}`, tactic_id: top.tactic.id, side: p.side, auto: true }; draw(true); }
  }
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !document.hidden && !L.wake) {
      L.wake = await navigator.wakeLock.request('screen');
      L.wake.addEventListener('release', () => { L.wake = null; });
    }
  } catch { /* not allowed, fine */ }
}

const onVisible = () => { if (!document.hidden && L.timer) { keepAwake(); poll(); } };

export function renderLive(el) {
  L.el = el;
  L.sigMain = null;
  draw(true);
}

export function startLive() {
  if (L.timer) return;
  poll();
  L.timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  L.channel = sb.channel('cs-calls').on('postgres_changes', { event: '*', schema: 'cs', table: 'calls' }, () => poll()).subscribe();
  document.addEventListener('visibilitychange', onVisible);
  keepAwake();
}

export function stopLive() {
  clearInterval(L.timer);
  L.timer = null;
  if (L.channel) { sb.removeChannel(L.channel); L.channel = null; }
  document.removeEventListener('visibilitychange', onVisible);
  L.wake?.release().catch(() => {});
  L.wake = null;
}
