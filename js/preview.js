// "Podgląd" tab: pick a spot (and where to look) on the radar, the Granko Recorder on the PC with
// CS2 teleports there and sends back a screenshot. Talks to it through cs.agent_jobs.
import {
  team, store, rpc, esc, toast, imageUrl, lightbox, MAPS, mapSwitch, bindSegmented, mapName,
} from './core.js';
import { hasRadar, mountSpotEditor } from './radar.js';
import { editLineup } from './lineups.js';

const ui = { map: store.get('cs.map') || MAPS[0].id, spot: null, shots: [], current: null, busy: false, agent: null, timer: null, el: null };

const online = () => !!ui.agent?.online;

function drawAgent() {
  const chip = ui.el?.querySelector('.agent-chip');
  const btn = ui.el?.querySelector('[data-act="go"]');
  if (!chip) return;
  chip.className = `agent-chip ${online() ? 'on' : ''}`;
  chip.innerHTML = online()
    ? `<span class="dot"></span>PC z CS2 online · ${esc(mapName(ui.agent.map))}`
    : `<span class="dot"></span>PC z CS2 offline`;
  btn.disabled = ui.busy || !online() || !ui.spot?.from;
  btn.textContent = ui.busy ? 'Czekam na grę…' : '📸 Pokaż w grze';
  ui.el.querySelector('.agent-help').hidden = online();
}

async function pollAgent() {
  try { ui.agent = await rpc('agent_status'); } catch { ui.agent = null; }
  drawAgent();
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
  hist.innerHTML = done.length > 1 ? done.map((x, i) => `<button type="button" class="pv-thumb ${x === ui.current ? 'on' : ''}" data-i="${ui.shots.indexOf(x)}">
    <img src="${esc(imageUrl(x.image))}" alt=""></button>`).join('') : '';
  hist.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { ui.current = ui.shots[+b.dataset.i]; drawResult(); });
}

async function go() {
  if (!ui.spot?.from || ui.busy) return;
  ui.busy = true;
  const shot = { status: 'pending', note: 'Wysyłam do PC…', map: ui.map, look: ui.spot.to || null };
  ui.shots.unshift(shot);
  ui.current = shot;
  drawAgent();
  drawResult();
  try {
    const id = await rpc('agent_submit', {
      p_kind: 'teleport', p_payload: { map: ui.map, at: ui.spot.from, look: ui.spot.to || null }, p_by: team.me,
    });
    // A map change on the PC takes a while; a plain teleport a few seconds.
    const limit = Date.now() + (ui.agent?.map === ui.map ? 45e3 : 180e3);
    while (Date.now() < limit) {
      await new Promise(r => setTimeout(r, 700));
      const job = await rpc('agent_job', { job_id: id });
      if (job.status === 'taken') {
        shot.note = ui.agent?.map === ui.map ? 'CS2 teleportuje i robi screena…' : `CS2 ładuje ${mapName(ui.map)}…`;
        drawResult();
      } else if (job.status === 'done') {
        Object.assign(shot, { status: 'done', ...job.result });
        break;
      } else if (job.status === 'error') {
        Object.assign(shot, { status: 'error', error: job.result?.error || 'Błąd' });
        break;
      }
    }
    if (shot.status === 'pending') Object.assign(shot, { status: 'error', error: 'PC nie odpowiedział na czas.' });
  } catch (err) {
    Object.assign(shot, { status: 'error', error: err.message });
  }
  ui.busy = false;
  drawAgent();
  drawResult();
}

export function renderPreview(el) {
  ui.el = el;
  el.innerHTML = `
    <div class="toolbar">${mapSwitch(ui.map)}</div>
    <div class="pv-grid">
      <section class="card pv-pick">
        <div class="pv-head"><h3>Gdzie stanąć</h3><span class="agent-chip"></span></div>
        <div class="pv-radar"></div>
        <button type="button" class="btn primary pv-go" data-act="go" disabled>📸 Pokaż w grze</button>
        <p class="muted small agent-help">Na PC z CS2 uruchom <b>Granko Recorder</b> (recorder/Granko Recorder.cmd). Gdy działa, ta strona może nim sterować z dowolnego urządzenia, także z telefonu.</p>
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
