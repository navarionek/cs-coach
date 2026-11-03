// "Podgląd" tab: remote control of the PC with CS2 through the Granko agent (cs.agent_jobs).
// Shows whether the PC and CS2 are up, starts or closes CS2 practice, and teleports the player to
// a spot picked on the radar, sending the screenshot back.
import {
  team, store, rpc, esc, toast, imageUrl, lightbox, MAPS, mapSwitch, bindSegmented, mapName,
} from './core.js';
import { hasRadar, mountSpotEditor } from './radar.js';
import { editLineup } from './lineups.js';

const ui = { map: store.get('cs.map') || MAPS[0].id, spot: null, shots: [], current: null, busy: null, agent: null, timer: null, el: null };

const CS2 = {
  off: 'CS2 wyłączony',
  game: 'CS2 w normalnej grze',
  practice: 'CS2 trening',
  ready: 'CS2 trening, Recorder gotowy',
};
const online = () => !!ui.agent?.online;
const cs2 = () => ui.agent?.info?.cs2 || 'off';

function drawAgent() {
  const el = ui.el;
  const chip = el?.querySelector('.agent-chip');
  if (!chip) return;
  const st = cs2();
  chip.className = `agent-chip ${online() ? (st === 'ready' ? 'on' : 'mid') : ''}`;
  chip.innerHTML = online()
    ? `<span class="dot"></span>PC online · ${esc(CS2[st] || st)}${st === 'ready' || st === 'practice' ? ` · ${esc(mapName(ui.agent.map))}` : ''}`
    : '<span class="dot"></span>PC offline';

  const ctl = el.querySelector('.pc-ctl');
  if (!online()) {
    ctl.innerHTML = '<p class="muted small">Włącz komputer z CS2. Agent Granko startuje sam razem z Windowsem i po chwili zobaczysz tu „PC online”.</p>';
  } else if (st === 'game') {
    ctl.innerHTML = '<p class="muted small">Na PC trwa normalna gra, więc agent niczego nie rusza. Trening włączysz po zamknięciu CS2.</p>';
  } else if (st === 'off') {
    ctl.innerHTML = `<button type="button" class="btn" data-act="start" ${ui.busy ? 'disabled' : ''}>▶ Uruchom CS2 + Recorder (${esc(mapName(ui.map))})</button>`;
  } else {
    ctl.innerHTML = `<button type="button" class="btn ghost" data-act="quit" ${ui.busy ? 'disabled' : ''}>■ Zamknij CS2</button>`;
  }
  if (ui.busy && ui.busy !== 'teleport') ctl.insertAdjacentHTML('beforeend', `<p class="muted small"><span class="spinner inline"></span> ${ui.busy === 'start' ? 'Uruchamiam CS2 i Recorder… (do 2 minut)' : 'Zamykam CS2…'}</p>`);
  ctl.querySelector('[data-act="start"]')?.addEventListener('click', () => control('start', { map: ui.map }));
  ctl.querySelector('[data-act="quit"]')?.addEventListener('click', () => control('quit', {}));

  const btn = el.querySelector('[data-act="go"]');
  btn.disabled = !!ui.busy || !online() || st === 'game' || !ui.spot?.from;
  btn.textContent = ui.busy === 'teleport' ? 'Czekam na grę…' : st === 'off' ? '📸 Uruchom grę i pokaż' : '📸 Pokaż w grze';
}

async function pollAgent() {
  try { ui.agent = await rpc('agent_status'); } catch { ui.agent = null; }
  drawAgent();
}

// Queues a job for the PC and waits for its result (a cold CS2 start can take a couple of minutes).
async function runJob(kind, payload, onTaken) {
  const id = await rpc('agent_submit', { p_kind: kind, p_payload: payload, p_by: team.me });
  const slow = kind === 'start' || cs2() === 'off' || (kind === 'teleport' && ui.agent?.map !== payload.map);
  const limit = Date.now() + (slow ? 200e3 : 45e3);
  let taken = false;
  while (Date.now() < limit) {
    await new Promise(r => setTimeout(r, 800));
    const job = await rpc('agent_job', { job_id: id });
    if (job.status === 'taken' && !taken) { taken = true; onTaken?.(); }
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw new Error(job.result?.error || 'Błąd');
  }
  throw new Error('PC nie odpowiedział na czas.');
}

async function control(kind, payload) {
  if (ui.busy) return;
  ui.busy = kind;
  drawAgent();
  try {
    await runJob(kind, payload);
    toast(kind === 'start' ? 'CS2 i Recorder gotowe' : 'CS2 zamknięty');
  } catch (err) {
    toast(err.message, 'err');
  }
  ui.busy = null;
  await pollAgent();
}

function drawResult() {
  const box = ui.el.querySelector('.pv-shot');
  const s = ui.current;
  if (!s) {
    box.innerHTML = `<div class="pv-empty"><div class="gate-ico">🎯</div><p class="muted">Kliknij na radarze, gdzie stanąć, potem gdzie patrzeć, i wciśnij <b>Pokaż w grze</b>. Screenshot z CS2 pojawi się tutaj.</p></div>`;
  } else if (s.status === 'pending') {
    box.innerHTML = `<div class="pv-empty"><span class="spinner"></span><p class="muted">${esc(s.note)}</p></div>`;
  } else if (s.status === 'error') {
    box.innerHTML = `<div class="pv-empty"><div class="gate-ico">⚠️</div><p class="error">${esc(s.error)}</p></div>`;
  } else {
    box.innerHTML = `
      <img class="pv-img" src="${esc(imageUrl(s.image))}" alt="">
      <div class="teleport"><code>${esc(s.setpos)}</code><button type="button" class="btn small" data-act="copy">📋 Kopiuj teleport</button></div>
      <div class="actions"><button type="button" class="btn primary" data-act="save">💾 Zapisz jako line-up</button></div>`;
    box.querySelector('.pv-img').onclick = () => lightbox([{ path: s.image, caption: 'aim' }]);
    box.querySelector('[data-act="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(s.setpos); toast('Skopiowano'); } catch { toast('Nie udało się skopiować', 'err'); }
    };
    box.querySelector('[data-act="save"]').onclick = () => editLineup(null, {
      map: s.map, side: 'T', nade: 'smoke', title: '', images: [{ path: s.image, caption: 'aim' }],
      spot: { from: s.at, ...(s.look ? { to: { ...s.look, level: s.at.level } } : {}) }, setpos: s.setpos,
    });
  }
  const hist = ui.el.querySelector('.pv-history');
  const done = ui.shots.filter(x => x.status === 'done');
  hist.innerHTML = done.length > 1 ? done.map(x => `<button type="button" class="pv-thumb ${x === ui.current ? 'on' : ''}" data-i="${ui.shots.indexOf(x)}">
    <img src="${esc(imageUrl(x.image))}" alt=""></button>`).join('') : '';
  hist.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { ui.current = ui.shots[+b.dataset.i]; drawResult(); });
}

async function go() {
  if (!ui.spot?.from || ui.busy) return;
  ui.busy = 'teleport';
  const shot = {
    status: 'pending', map: ui.map, look: ui.spot.to || null,
    note: cs2() === 'off' ? 'Uruchamiam CS2 na PC… (do 2 minut)' : 'Wysyłam do PC…',
  };
  ui.shots.unshift(shot);
  ui.current = shot;
  drawAgent();
  drawResult();
  try {
    const result = await runJob('teleport', { map: ui.map, at: ui.spot.from, look: ui.spot.to || null }, () => {
      shot.note = ui.agent?.map === ui.map && cs2() === 'ready' ? 'CS2 teleportuje i robi screena…' : `CS2 przygotowuje ${mapName(ui.map)}…`;
      drawResult();
    });
    Object.assign(shot, { status: 'done', ...result });
  } catch (err) {
    Object.assign(shot, { status: 'error', error: err.message });
  }
  ui.busy = null;
  await pollAgent();
  drawResult();
}

export function renderPreview(el) {
  ui.el = el;
  el.innerHTML = `
    <div class="toolbar">${mapSwitch(ui.map)}</div>
    <div class="pv-grid">
      <section class="card pv-pick">
        <div class="pv-head"><h3>Gdzie stanąć</h3><span class="agent-chip"></span></div>
        <div class="pc-ctl"></div>
        <div class="pv-radar"></div>
        <button type="button" class="btn primary pv-go" data-act="go" disabled>📸 Pokaż w grze</button>
      </section>
      <section class="card pv-result">
        <div class="pv-shot"></div>
        <div class="pv-history"></div>
      </section>
    </div>`;
  bindSegmented(el, 'map', v => { ui.map = v; store.set('cs.map', v); ui.spot = null; renderPreview(el); });
  const radar = el.querySelector('.pv-radar');
  if (hasRadar(ui.map)) {
    mountSpotEditor(radar, {
      map: ui.map, spot: ui.spot, nade: 'decoy', side: 'any', onChange: s => { ui.spot = s; drawAgent(); },
      labels: { from: '📍 Stań tu', to: '👁 Patrz tam', hintFrom: 'Kliknij, gdzie postać ma stanąć.', hintTo: 'Kliknij, w którą stronę ma patrzeć (opcjonalnie).' },
    });
  } else {
    radar.innerHTML = '<p class="muted">Ta mapa nie ma radaru.</p>';
  }
  el.querySelector('[data-act="go"]').onclick = go;
  drawAgent();
  drawResult();
}

export function startPreview() {
  if (ui.timer) return;
  pollAgent();
  ui.timer = setInterval(() => { if (!document.hidden) pollAgent(); }, 3000);
}

export function stopPreview() {
  clearInterval(ui.timer);
  ui.timer = null;
}
