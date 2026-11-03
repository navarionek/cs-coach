// CS Coach: read-only view of the cs schema (players, matches, rounds, live).
const SUPABASE_URL = 'https://qnhzbnofloghyhbmkvnq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wDsMbOBSA67oTBVOcan80g_mLhKrnqW';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { db: { schema: 'cs' } });

const STALE_MS = 20 * 60e3;     // a live match with no update for this long was left
const SAME_GAME_MS = 10 * 60e3; // teammates' matches on one map starting this close are one game
const LIVE_MS = 2 * 60e3;       // heartbeat is 60 s, so 2 min without a payload = not playing

const REASONS = {
  elimination: { icon: '☠', label: 'eliminacja' },
  bomb: { icon: '💣', label: 'bomba' },
  defuse: { icon: '✂', label: 'rozbrojenie' },
  time: { icon: '⏱', label: 'czas' },
};

const state = { players: {}, matches: [], rounds: {}, live: [], open: new Set() };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const t = iso => iso ? new Date(iso).getTime() : null;
const mapName = m => { const n = String(m || '').replace(/^(de|cs|ar)_/, ''); return n.charAt(0).toUpperCase() + n.slice(1); };
const modeName = m => ({ competitive: 'Competitive / Premier', scrimcomp2v2: 'Wingman', casual: 'Casual', deathmatch: 'Deathmatch' })[m] || m || '';
const playerName = id => state.players[id]?.name || id;
const fmtDur = ms => {
  if (ms == null || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = iso => new Date(iso).toLocaleString('pl-PL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '–';
const ratio = (a, b) => b ? (a / b).toFixed(2) : (a ? a.toFixed(2) : '–');
const reasonOf = r => REASONS[(r?.win_reason || '').replace(/^(ct|t)_win_/, '')];

function effectiveStatus(m) {
  if (m.status === 'live' && Date.now() - t(m.last_update) > STALE_MS) return 'abandoned';
  return m.status;
}

async function load() {
  const [players, matches, live] = await Promise.all([
    sb.from('players').select('steamid,name,last_seen'),
    sb.from('matches')
      .select('id,steamid,map,mode,status,started_at,ended_at,last_update,team,score_ct,score_t,kills,assists,deaths,mvps,score,rounds_recorded')
      .order('started_at', { ascending: false }).limit(150),
    sb.from('live').select('steamid,received_at,state'),
  ]);
  const err = players.error || matches.error || live.error;
  if (err) {
    document.getElementById('matches').innerHTML = `<p class="error">Nie udało się pobrać danych: ${esc(err.message)}</p>`;
    return;
  }
  state.players = Object.fromEntries(players.data.map(p => [p.steamid, p]));
  state.matches = matches.data;
  state.live = live.data;

  state.rounds = {};
  const ids = state.matches.map(m => m.id);
  if (ids.length) {
    const rounds = await sb.from('rounds').select('*').in('match_id', ids).order('round_no');
    if (!rounds.error) {
      for (const r of rounds.data) (state.rounds[r.match_id] ||= []).push(r);
    }
  }
  render();
}

// One game seen by up to five of us: same map, starts within a few minutes.
function groupGames(matches) {
  const games = [];
  for (const m of [...matches].sort((a, b) => t(b.started_at) - t(a.started_at))) {
    const start = t(m.started_at);
    const g = games.find(g => g.map === m.map && Math.abs(g.start - start) < SAME_GAME_MS && !g.members.some(x => x.steamid === m.steamid));
    if (g) g.members.push(m);
    else games.push({ key: `${m.map}-${start}`, map: m.map, start, members: [m] });
  }
  for (const g of games) {
    const rank = { finished: 2, live: 1, abandoned: 0 };
    g.members.sort((a, b) => (rank[effectiveStatus(b)] - rank[effectiveStatus(a)]) || (b.rounds_recorded - a.rounds_recorded));
    g.rep = g.members[0];
    g.status = effectiveStatus(g.rep);
    const side = g.rep.team;
    g.us = side === 'T' ? g.rep.score_t : g.rep.score_ct;
    g.them = side === 'T' ? g.rep.score_ct : g.rep.score_t;
    g.known = side === 'CT' || side === 'T';
    g.end = t(g.rep.ended_at) || t(g.rep.last_update);
  }
  return games;
}

function memberStats(m) {
  const rs = (state.rounds[m.id] || []).filter(r => r.kills != null);
  const dmg = rs.reduce((s, r) => s + (r.damage || 0), 0);
  const kills = rs.reduce((s, r) => s + (r.kills || 0), 0);
  const hs = rs.reduce((s, r) => s + (r.headshots || 0), 0);
  return { rounds: rs.length, adr: rs.length ? Math.round(dmg / rs.length) : null, hs: pct(hs, kills), survived: rs.filter(r => r.survived).length };
}

function renderLive() {
  const el = document.getElementById('live');
  const now = Date.now();
  const playing = state.live.filter(l => now - t(l.received_at) < LIVE_MS && l.state?.map);
  if (!playing.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="pulse"></span><b>Grają teraz</b>` + playing.map(l => {
    const s = l.state, own = s.player?.steamid === l.steamid;
    const hp = own ? s.player?.state?.health : 0;
    const phase = s.map.phase === 'gameover' ? 'koniec meczu' : s.map.phase === 'intermission' ? 'przerwa' : s.map.phase === 'warmup' ? 'rozgrzewka' : { freezetime: 'kupowanie', live: 'runda', over: 'koniec rundy' }[s.round?.phase] || s.map.phase;
    return `<span class="chip">
      <b>${esc(playerName(l.steamid))}</b> · ${esc(mapName(s.map.name))}
      <span class="ct">${s.map.team_ct?.score ?? 0}</span>:<span class="t">${s.map.team_t?.score ?? 0}</span>
      · ${esc(phase)} ${own && s.round?.phase === 'live' ? (hp > 0 ? `· ${hp} HP` : '· ☠') : (!own ? '· obserwuje' : '')}
    </span>`;
  }).join('');
}

function renderMatches() {
  const el = document.getElementById('matches');
  const games = groupGames(state.matches);
  if (!games.length) {
    el.innerHTML = `<div class="card empty"><h2>Jeszcze pusto</h2><p>Wrzućcie plik cfg do gry (zakładka <b>Instalacja</b>) i zagrajcie mecz. Pojawi się tutaj po rozgrzewce.</p></div>`;
    return;
  }
  el.innerHTML = games.map(renderGame).join('');
  el.querySelectorAll('[data-game]').forEach(h => h.addEventListener('click', () => {
    const k = h.dataset.game;
    state.open.has(k) ? state.open.delete(k) : state.open.add(k);
    renderMatches();
  }));
}

function renderGame(g) {
  let badge;
  if (g.status === 'live') badge = `<span class="badge live">NA ŻYWO</span>`;
  else if (g.status === 'abandoned') badge = `<span class="badge">przerwany</span>`;
  else if (!g.known) badge = `<span class="badge">koniec</span>`;
  else badge = g.us > g.them ? `<span class="badge win">WYGRANA</span>` : g.us < g.them ? `<span class="badge loss">PRZEGRANA</span>` : `<span class="badge">REMIS</span>`;
  const score = g.known ? `${g.us}<span class="sep">:</span>${g.them}` : `${g.rep.score_ct}<span class="sep">:</span>${g.rep.score_t}`;
  const open = state.open.has(g.key);
  const members = [...g.members].sort((a, b) => (b.kills ?? -1) - (a.kills ?? -1));

  return `<article class="card game ${open ? 'open' : ''} ${g.status === 'finished' && g.known ? (g.us > g.them ? 'is-win' : g.us < g.them ? 'is-loss' : '') : ''}">
    <header class="game-head" data-game="${esc(g.key)}">
      <div class="map map-${esc(g.map)}">${esc(mapName(g.map))}</div>
      <div class="meta">
        <div class="when">${esc(fmtDate(g.rep.started_at))}</div>
        <div class="muted">${esc(modeName(g.rep.mode))} · ${fmtDur(g.end - g.start)} · ${g.rep.rounds_recorded} rund</div>
      </div>
      <div class="score">${score}</div>
      ${badge}
    </header>
    <table class="scoreboard">
      <thead><tr><th>Gracz</th><th>K</th><th>A</th><th>D</th><th>K/D</th><th>ADR</th><th>HS</th><th>MVP</th></tr></thead>
      <tbody>${members.map(m => {
        const s = memberStats(m);
        return `<tr><td class="name">${esc(playerName(m.steamid))}</td><td>${m.kills ?? '–'}</td><td>${m.assists ?? '–'}</td><td>${m.deaths ?? '–'}</td>
          <td>${m.kills != null ? ratio(m.kills, m.deaths) : '–'}</td><td>${s.adr ?? '–'}</td><td>${s.hs}</td><td>${m.mvps ?? '–'}</td></tr>`;
      }).join('')}</tbody>
    </table>
    ${open ? renderRounds(g, members) : `<button class="more" data-game="${esc(g.key)}">Rundy ▾</button>`}
  </article>`;
}

function renderRounds(g, members) {
  const n = Math.max(...g.members.map(m => m.rounds_recorded), 0);
  if (!n) return `<p class="muted pad">Brak zakończonych rund.</p><button class="more" data-game="${esc(g.key)}">Zwiń ▴</button>`;
  const byMember = new Map(members.map(m => [m.steamid, Object.fromEntries((state.rounds[m.id] || []).map(r => [r.round_no, r]))]));
  const rounds = [];
  for (let i = 1; i <= n; i++) {
    const rows = members.map(m => byMember.get(m.steamid)[i]).filter(Boolean);
    const withSide = rows.find(r => r.won != null);
    const any = rows.find(r => r.win_reason) || rows[0];
    const timed = rows.find(r => r.started_at && r.ended_at);
    rounds.push({ no: i, won: withSide?.won, reason: reasonOf(any), winner: any?.winner, dur: timed ? t(timed.ended_at) - t(timed.started_at) : null });
  }
  const half = 12; // MR12: sides swap after round 12, overtime halves are 3 rounds
  const cols = rounds.map(r => `<div class="rnd ${r.won === true ? 'w' : r.won === false ? 'l' : ''} ${r.no === half ? 'half' : ''}"
      title="Runda ${r.no}: ${r.winner || '?'} · ${r.reason?.label || '?'} · ${fmtDur(r.dur)}">
      <span class="no">${r.no}</span><span class="ico">${r.reason?.icon || '·'}</span><span class="dur">${fmtDur(r.dur)}</span></div>`).join('');

  const grid = members.map(m => {
    const rs = byMember.get(m.steamid);
    return `<div class="grid-row"><div class="gname">${esc(playerName(m.steamid))}</div>${rounds.map(r => {
      const x = rs[r.no];
      if (!x || x.kills == null) return `<div class="k none ${r.no === half ? 'half' : ''}">·</div>`;
      const tip = `Runda ${r.no}: ${x.kills} kill (${x.headshots ?? 0} HS), ${x.damage ?? '?'} dmg, sprzęt $${x.equip_value ?? '?'}, kasa na start $${x.money_start ?? '?'}${x.survived ? ', przeżył' : ', zginął'}`;
      return `<div class="k k${Math.min(x.kills, 5)} ${x.survived ? '' : 'dead'} ${r.no === half ? 'half' : ''}" title="${esc(tip)}">${x.kills || ''}</div>`;
    }).join('')}</div>`;
  }).join('');

  const timed = rounds.filter(r => r.dur != null);
  const avg = timed.length ? timed.reduce((s, r) => s + r.dur, 0) / timed.length : null;
  const won = rounds.filter(r => r.won === true), lost = rounds.filter(r => r.won === false);
  const avgOf = rs => { const x = rs.filter(r => r.dur != null); return x.length ? x.reduce((s, r) => s + r.dur, 0) / x.length : null; };

  return `<div class="rounds">
    <div class="facts">
      <span>Średnia runda <b>${fmtDur(avg)}</b></span>
      <span>Wygrane rundy <b>${fmtDur(avgOf(won))}</b></span>
      <span>Przegrane rundy <b>${fmtDur(avgOf(lost))}</b></span>
    </div>
    <div class="scroll">
      <div class="strip">${cols}</div>
      <div class="grid">${grid}</div>
    </div>
    <p class="legend muted">Kolor rundy: zielona = wygrana, czerwona = przegrana. W siatce liczba killi, czerwona kreska pod spodem = zginął. Najedź na komórkę po szczegóły.</p>
    <button class="more" data-game="${esc(g.key)}">Zwiń ▴</button>
  </div>`;
}

function renderPlayers() {
  const el = document.getElementById('players');
  const games = groupGames(state.matches).filter(g => g.status === 'finished');
  const agg = {};
  for (const g of games) {
    for (const m of g.members) {
      const a = (agg[m.steamid] ||= { games: 0, wins: 0, losses: 0, k: 0, d: 0, a: 0, mvps: 0, rounds: 0, dmg: 0, hs: 0, rk: 0, survived: 0, equip: 0, equipN: 0 });
      a.games++;
      if (g.known && g.us > g.them) a.wins++;
      if (g.known && g.us < g.them) a.losses++;
      a.k += m.kills || 0; a.d += m.deaths || 0; a.a += m.assists || 0; a.mvps += m.mvps || 0;
      for (const r of state.rounds[m.id] || []) {
        if (r.kills == null) continue;
        a.rounds++; a.dmg += r.damage || 0; a.hs += r.headshots || 0; a.rk += r.kills; a.survived += r.survived ? 1 : 0;
        if (r.equip_value != null) { a.equip += r.equip_value; a.equipN++; }
      }
    }
  }
  const rows = Object.entries(agg).sort((x, y) => y[1].k / Math.max(y[1].d, 1) - x[1].k / Math.max(x[1].d, 1));
  if (!rows.length) { el.innerHTML = `<div class="card empty"><p>Statystyki pojawią się po pierwszym skończonym meczu.</p></div>`; return; }
  el.innerHTML = `<div class="cards">${rows.map(([id, a]) => `
    <div class="card pcard">
      <h3>${esc(playerName(id))}</h3>
      <div class="muted">${a.games} meczów · ${a.wins}W ${a.losses}L · ${pct(a.wins, a.wins + a.losses)} wygranych</div>
      <div class="stats">
        <div><b>${ratio(a.k, a.d)}</b><span>K/D</span></div>
        <div><b>${a.rounds ? Math.round(a.dmg / a.rounds) : '–'}</b><span>ADR</span></div>
        <div><b>${pct(a.hs, a.rk)}</b><span>HS</span></div>
        <div><b>${a.rounds ? (a.rk / a.rounds).toFixed(2) : '–'}</b><span>kille / runda</span></div>
        <div><b>${pct(a.survived, a.rounds)}</b><span>przeżyte rundy</span></div>
        <div><b>${a.equipN ? '$' + Math.round(a.equip / a.equipN) : '–'}</b><span>śr. sprzęt</span></div>
      </div>
      <div class="muted small">${a.k} K · ${a.a} A · ${a.d} D · ${a.mvps} MVP · ${a.rounds} rund z danymi</div>
    </div>`).join('')}</div>`;
}

function render() {
  renderLive();
  renderMatches();
  renderPlayers();
}

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
}));

load();
setInterval(load, 20000);
// An installed PWA resumed from the background doesn't reload, so refresh right away.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

if ('serviceWorker' in navigator) {
  // A new SW took over: reload to pick up the new code (not on the very first install).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed:', err));
  });
}
