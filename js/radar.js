// Radar (overhead map) views: lineup spots (where it's thrown from, where it lands), tactic routes
// (where each role walks) and zoom/pan for all of them. Points are 0..1 fractions of the square
// radar image; Nuke's two floors share one coordinate frame, so a route can go up or down stairs.
// Under everything sit the game's callout zones with their names (🏷 toggles them).
import { team, store, esc, imageUrl, NADES, segmented, bindSegmented, member } from './core.js';
import { SPAWNS } from './mapdata.js';
import { calloutsFor, placeAt, calloutPoint, calloutOptions, routePlaces } from './callouts.js';
import { loadNav, track as walkTrack } from './nav.js';

const LEVEL_NAMES = { main: 'Góra', lower: 'Dół' };
export const NADE_COLORS = { smoke: '#d5deec', flash: '#fff3a3', molotov: '#ff9a5c', he: '#ff7a8c', decoy: '#b5bfcf' };
const SIDE_COLORS = { T: '#ffb547', CT: '#5ab4ff', any: '#e8ecf3' };
const SLOT_COLORS = ['#ff8a3d', '#5ab4ff', '#3ddc97', '#c77dff', '#ffd166'];
const MAX_ZOOM = 6;

export const radarsFor = map => (team.playbook?.radars || []).filter(r => r.map === map)
  .sort((a, b) => (a.level === 'main' ? -1 : 1) - (b.level === 'main' ? -1 : 1));
export const hasRadar = map => radarsFor(map).length > 0;
export const roleColor = (role, i) => member(role.member_id)?.color || SLOT_COLORS[i % SLOT_COLORS.length];
const n2 = v => v.toFixed(2);
let uid = 0;

function levelSwitch(map, level, name) {
  const rs = radarsFor(map);
  return rs.length > 1 ? segmented(name, rs.map(r => [r.level, LEVEL_NAMES[r.level] || r.level]), level) : '';
}

function radarImg(map, level) {
  const r = radarsFor(map).find(x => x.level === level) || radarsFor(map)[0];
  return r ? `<img class="r-img" src="${esc(imageUrl(r.path))}" alt="" draggable="false">` : '';
}

// Spawn points under everything else, so routes and lineups read from where the round starts.
function spawnMarks(map, level) {
  const sp = SPAWNS[map];
  if (!sp) return '';
  return [["T", sp.T], ["CT", sp.CT]].flatMap(([side, pts]) => pts.filter(p => p.level === level)
    .map(p => `<span class="r-spawn ${side.toLowerCase()}" style="left:${n2(p.x * 100)}%;top:${n2(p.y * 100)}%" title="Spawn ${side}"></span>`)).join('');
}

// Callout zones (an SVG of their own, under the routes) and their names. Small places only get a
// name once you zoom in, so Nuke's stacked rooms don't pile up on the whole-map view.
const MINOR = 0.001;
document.documentElement.classList.toggle('no-callouts', store.get('cs.callouts') === 'off');
function calloutLayer(map, level) {
  const cs = calloutsFor(map);
  if (!cs.length) return { svg: '', marks: '' };
  const svg = cs.flatMap(c => c.zones.filter(z => z.level === level).map(z =>
    `<polygon class="r-zone" data-c="${esc(c.id)}" points="${z.poly.map(([x, y]) => `${n2(x * 100)},${n2(y * 100)}`).join(' ')}" />`)).join('');
  const marks = cs.flatMap(c => c.labels.filter(l => l.level === level).map(l =>
    `<span class="r-call ${l.a < MINOR ? 'minor' : ''}" data-c="${esc(c.id)}" style="left:${n2(l.x * 100)}%;top:${n2(l.y * 100)}%">${esc(c.name)}</span>`)).join('');
  return { svg, marks };
}

// One radar box. Everything that zooms lives in .r-stage; the zoom buttons sit outside it.
function radarBox(map, level, { svg = '', marks = '', cls = '', zoom = false } = {}) {
  const C = calloutLayer(map, level);
  return `<div class="radar ${cls}">
    <div class="r-stage">${radarImg(map, level)}
      <svg class="r-svg r-zones" viewBox="0 0 100 100" preserveAspectRatio="none">${C.svg}</svg>
      <svg class="r-svg" viewBox="0 0 100 100" preserveAspectRatio="none">${svg}</svg>${C.marks}${spawnMarks(map, level)}${marks}</div>
    ${zoom ? `<div class="r-zoom"><button type="button" data-z="in" aria-label="Przybliż">+</button>
      <button type="button" data-z="out" aria-label="Oddal">−</button><button type="button" data-z="reset" aria-label="Cała mapa">⟲</button>
      ${C.svg ? '<button type="button" data-z="callouts" aria-label="Callouty" title="Pokaż / ukryj callouty">🏷</button>' : ''}</div>` : ''}
  </div>`;
}

// Editors: the callout under the pointer lights up and its name shows in `out`.
function hoverCallouts(box, map, level, out) {
  let cur = null;
  const set = id => {
    if (id === cur) return;
    cur = id;
    box.querySelectorAll('.r-zone.hot, .r-call.hot').forEach(n => n.classList.remove('hot'));
    if (id) box.querySelectorAll(`[data-c="${CSS.escape(id)}"]`).forEach(n => n.classList.add('hot'));
  };
  box.addEventListener('pointermove', e => {
    const c = placeAt(map, pointFrom(box, e, level));
    set(c?.id || null);
    if (out) out.textContent = c ? `📍 ${c.name}` : '';
  });
  box.addEventListener('pointerleave', () => { set(null); if (out) out.textContent = ''; });
}

// Zoom & pan on a radar box: wheel, pinch, drag, +/−/⟲. `state` ({z, x, y}) is owned by the
// caller so the view survives redraws. A drag never counts as a click, so editors can keep using
// plain clicks to add points; `ignore` marks elements that handle their own dragging.
function enableZoom(box, state, { ignore = null } = {}) {
  const stage = box.querySelector('.r-stage');
  const pointers = new Map();
  let start = null;
  let panned = false;

  const clamp = () => {
    const w = box.clientWidth, h = box.clientHeight;
    state.z = Math.min(MAX_ZOOM, Math.max(1, state.z));
    state.x = Math.min(0, Math.max(w - w * state.z, state.x));
    state.y = Math.min(0, Math.max(h - h * state.z, state.y));
  };
  const apply = () => {
    clamp();
    stage.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.z})`;
    stage.style.setProperty('--z', state.z);
    box.classList.toggle('zoomed', state.z > 1.01);
  };
  // Zoom to `nz` keeping the box point (cx, cy) under the same spot of the map.
  const zoomAt = (nz, cx, cy) => {
    nz = Math.min(MAX_ZOOM, Math.max(1, nz));
    state.x = cx - (cx - state.x) * (nz / state.z);
    state.y = cy - (cy - state.y) * (nz / state.z);
    state.z = nz;
    apply();
  };
  const local = e => { const r = box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  box.addEventListener('wheel', e => {
    e.preventDefault();
    const p = local(e);
    zoomAt(state.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), p.x, p.y);
  }, { passive: false });

  box.addEventListener('pointerdown', e => {
    if (e.target.closest('.r-zoom') || (ignore && e.target.closest(ignore))) return;
    pointers.set(e.pointerId, local(e));
    panned = false;
    start = { x: state.x, y: state.y, z: state.z, pts: [...pointers.values()].map(p => ({ ...p })) };
  });
  box.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    const pts = [...pointers.values()];
    if (pts.length >= 2 && start.pts.length >= 2) {
      // Pinch: scale by finger distance, around the midpoint.
      const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      Object.assign(state, { x: start.x, y: start.y, z: start.z });
      zoomAt(start.z * d(pts[0], pts[1]) / Math.max(1, d(start.pts[0], start.pts[1])), mid.x, mid.y);
      panned = true;
    } else if (pts.length === 1) {
      const dx = pts[0].x - start.pts[0].x, dy = pts[0].y - start.pts[0].y;
      if (!panned && Math.hypot(dx, dy) < 5) return;
      if (!panned) box.setPointerCapture(e.pointerId);
      panned = true;
      state.x = start.x + dx;
      state.y = start.y + dy;
      apply();
    }
  });
  const end = e => {
    pointers.delete(e.pointerId);
    if (pointers.size) start = { x: state.x, y: state.y, z: state.z, pts: [...pointers.values()].map(p => ({ ...p })) };
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  // A pan or pinch ends with a click event; swallow it before the editors see it.
  box.addEventListener('click', e => {
    if (panned) { e.stopImmediatePropagation(); e.preventDefault(); panned = false; }
  }, { capture: true });

  box.querySelectorAll('.r-zoom button').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const c = { x: box.clientWidth / 2, y: box.clientHeight / 2 };
    if (b.dataset.z === 'in') zoomAt(state.z * 1.5, c.x, c.y);
    if (b.dataset.z === 'out') zoomAt(state.z / 1.5, c.x, c.y);
    if (b.dataset.z === 'reset') { state.z = 1; state.x = 0; state.y = 0; apply(); }
    if (b.dataset.z === 'callouts') {
      const hidden = document.documentElement.classList.toggle('no-callouts');
      store.set('cs.callouts', hidden ? 'off' : null);
    }
  }));
  apply();
}

// Point under the pointer as radar fractions; the stage's rect already includes zoom and pan.
function pointFrom(box, e, level) {
  const r = box.querySelector('.r-stage').getBoundingClientRect();
  const f = v => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return { x: f((e.clientX - r.left) / r.width), y: f((e.clientY - r.top) / r.height), level };
}

// --- lineups: throw lines and landing markers ---

function lineupLayer(lineups, level, { labels = false } = {}) {
  const withSpot = lineups.filter(l => l.spot?.from || l.spot?.to);
  const svg = withSpot.filter(l => l.spot.from && l.spot.to).map(l => {
    const { from, to } = l.spot;
    const cross = (from.level || 'main') !== (to.level || 'main');
    return `<line x1="${n2(from.x * 100)}" y1="${n2(from.y * 100)}" x2="${n2(to.x * 100)}" y2="${n2(to.y * 100)}"
      class="throw-line" stroke="${NADE_COLORS[l.nade] || '#fff'}" stroke-dasharray="${cross ? '.6 1.2' : '1.6 .9'}" />`;
  }).join('');
  const marks = withSpot.flatMap(l => {
    const out = [];
    const { from, to } = l.spot;
    if (from && (from.level || 'main') === level) {
      out.push(`<span class="r-from" style="left:${n2(from.x * 100)}%;top:${n2(from.y * 100)}%;--c:${SIDE_COLORS[l.side] || '#fff'}" title="${esc(l.title)}: skąd"></span>`);
    }
    if (to && (to.level || 'main') === level) {
      out.push(`<button type="button" class="r-to" data-open-lineup="${esc(l.id)}"
        style="left:${n2(to.x * 100)}%;top:${n2(to.y * 100)}%;--c:${NADE_COLORS[l.nade]}" title="${esc(l.title)}">${NADES[l.nade]?.icon || '•'}
        ${labels ? `<span class="r-label">${esc(l.title)}</span>` : ''}</button>`);
    }
    return out;
  }).join('');
  return { svg, marks };
}

// --- routes: start, waypoints and destination of each role ---

// Catmull-Rom through the points, as cubic Béziers, so routes read as movement, not zigzags.
// A walked track bends less (k), so its corners stay off the walls.
function smoothPath(pts, k = 6) {
  if (pts.length === 2) return `M${n2(pts[0].x)} ${n2(pts[0].y)} L${n2(pts[1].x)} ${n2(pts[1].y)}`;
  let d = `M${n2(pts[0].x)} ${n2(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${n2(p1.x + (p2.x - p0.x) / k)} ${n2(p1.y + (p2.y - p0.y) / k)} ${n2(p2.x - (p3.x - p1.x) / k)} ${n2(p2.y - (p3.y - p1.y) / k)} ${n2(p2.x)} ${n2(p2.y)}`;
  }
  return d;
}

// Glowing, flowing route lines plus start/waypoint/end markers for every role on one level.
// `highlight` (a role index) dims the others; parts of a route on the other Nuke floor stay faint.
// The line follows the role's walked track when it has one; the markers are the points you set.
function routeLayer(roles, level, { highlight = null } = {}) {
  const fid = `rglow${++uid}`;
  let svg = '', marks = '';
  const scale = list => (list || []).map(p => ({ x: p.x * 100, y: p.y * 100, level: p.level || 'main' }));
  roles.forEach((role, i) => {
    const pts = scale(role.path);
    if (!pts.length) return;
    const walked = role.track?.length > 1;
    const line = walked ? scale(role.track) : pts;
    const c = roleColor(role, i);
    const dim = highlight != null && highlight !== i;
    const runs = [];
    let run = [];
    line.forEach((p, k) => {
      if (p.level === level) run.push(p);
      else if (run.length) { runs.push(run); run = []; }
      const q = line[k + 1];
      if (q && !(p.level === level && q.level === level)) {
        svg += `<line x1="${n2(p.x)}" y1="${n2(p.y)}" x2="${n2(q.x)}" y2="${n2(q.y)}" class="route-cross" stroke="${c}" opacity="${dim ? '.15' : '.4'}" />`;
      }
    });
    if (run.length) runs.push(run);
    for (const r of runs.filter(r => r.length > 1)) {
      const d = smoothPath(r, walked ? 12 : 6);
      svg += `<g class="route ${dim ? 'dim' : ''}" style="--c:${c}">
        <path d="${d}" class="route-glow" filter="url(#${fid})" />
        <path d="${d}" class="route-line" />
        <path d="${d}" class="route-flow" />
      </g>`;
    }
    pts.forEach((p, k) => {
      if (p.level !== level) return;
      const kind = pts.length === 1 || k === 0 ? 'start' : k === pts.length - 1 ? 'end' : 'via';
      marks += `<span class="rt-pt ${kind} ${dim ? 'dim' : ''}" data-role="${i}" data-pt="${k}" style="left:${n2(p.x)}%;top:${n2(p.y)}%;--c:${c}"
        title="${esc(role.name || 'Rola')}${kind === 'start' ? ': start' : kind === 'end' ? ': cel' : ''}">${kind === 'start' ? esc((role.name || '?').charAt(0).toUpperCase()) : ''}${kind === 'end' ? `<span class="r-label">${esc(role.name || '')}</span>` : ''}</span>`;
    });
  });
  return {
    svg: `<defs><filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".9" /></filter></defs>${svg}`,
    marks,
  };
}

// The floor most of the content is on.
function dominantLevel(map, { roles = [], lineups = [] }) {
  const counts = {};
  const add = lv => { if (lv) counts[lv] = (counts[lv] || 0) + 1; };
  roles.flatMap(r => r.path || []).forEach(p => add(p.level || 'main'));
  lineups.forEach(l => add(l.spot?.to?.level || l.spot?.from?.level));
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || radarsFor(map)[0]?.level || 'main';
}

export const hasPlan = (roles, lineups = []) => roles.some(r => r.path?.length) || lineups.some(l => l.spot);

function planBox(map, roles, lineups, level, { highlight = null, cls = '', zoom = false } = {}) {
  const R = routeLayer(roles, level, { highlight });
  const L = lineupLayer(lineups, level);
  return radarBox(map, level, { svg: R.svg + L.svg, marks: R.marks + L.marks, cls: `plan ${cls}`, zoom });
}

// "🧭 T spawn → T Ramp → Banana → B site": the callouts a role walks through (its track when it
// has one, else straight between its points).
export function routeLine(map, path, track = null) {
  const names = routePlaces(map, track?.length > 1 ? track : path).map(c => c.name);
  return names.length ? `<span class="r-chain">🧭 ${names.map(esc).join(' → ')}</span>` : '';
}

// The walked track for a path on this map, or null (no mesh, fewer than two points).
export async function trackFor(map, path) {
  if (!path || path.length < 2) return null;
  return walkTrack(await loadNav(map), path);
}

// --- public views ---

// Static radar with throw lines; markers carry data-open-lineup for the caller to bind.
export function radarStatic(map, lineups, { cls = '' } = {}) {
  if (!hasRadar(map) || !lineups.some(l => l.spot)) return '';
  const level = dominantLevel(map, { lineups });
  const L = lineupLayer(lineups, level);
  return radarBox(map, level, { svg: L.svg, marks: L.marks, cls });
}

// Static team plan (routes + lineups), optionally with one role highlighted.
export function planStatic(map, roles, { highlight = null, lineups = [], cls = '' } = {}) {
  if (!hasRadar(map) || !hasPlan(roles, lineups)) return '';
  return planBox(map, roles, lineups, dominantLevel(map, { roles, lineups }), { highlight, cls });
}

// Interactive team plan with zoom, floor switch and legend; landing markers call onOpen(lineupId).
export function mountPlan(el, { map, roles, lineups = [], highlight = null, onOpen }) {
  if (!hasRadar(map) || !hasPlan(roles, lineups)) { el.innerHTML = ''; return; }
  let level = dominantLevel(map, { roles, lineups });
  const zoom = { z: 1, x: 0, y: 0 };
  const draw = () => {
    el.innerHTML = `<div class="plan-wrap">
      ${levelSwitch(map, level, 'plevel')}
      ${planBox(map, roles, lineups, level, { highlight, zoom: true })}
      <div class="plan-legend">${roles.map((r, i) => r.path?.length
        ? `<span style="--c:${roleColor(r, i)}" class="${highlight != null && highlight !== i ? 'dim' : ''}">${esc(r.name || 'Rola')}${member(r.member_id) ? ` · ${esc(member(r.member_id).name)}` : ''}</span>` : '').join('')}</div>
    </div>`;
    bindSegmented(el, 'plevel', v => { level = v; draw(); });
    enableZoom(el.querySelector('.radar'), zoom);
    el.querySelectorAll('[data-open-lineup]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); onOpen?.(b.dataset.openLineup); }));
  };
  draw();
}

// Interactive map of many lineups; clicking a landing marker calls onOpen.
export function mountLineupMap(el, { map, lineups, onOpen }) {
  let level = dominantLevel(map, { lineups });
  const zoom = { z: 1, x: 0, y: 0 };
  const draw = () => {
    const placed = lineups.filter(l => l.spot);
    const L = lineupLayer(placed, level, { labels: true });
    el.innerHTML = `
      <div class="radar-wrap">
        ${levelSwitch(map, level, 'rlevel')}
        ${radarBox(map, level, { svg: L.svg, marks: L.marks, cls: 'big', zoom: true })}
        <p class="muted small">${placed.length ? 'Kropka to miejsce rzutu (kolor strony), ikona to miejsce, gdzie granat ląduje. Kliknij ikonę, żeby otworzyć line-up. Kółko myszy lub dwa palce przybliżają.' : 'Żaden z tych line-upów nie ma jeszcze zaznaczonego miejsca na mapie. Zaznaczysz je w edytorze line-upu.'}
        ${lineups.length > placed.length && placed.length ? ` ${lineups.length - placed.length} bez miejsca na mapie.` : ''}</p>
      </div>`;
    bindSegmented(el, 'rlevel', v => { level = v; draw(); });
    enableZoom(el.querySelector('.radar'), zoom);
    el.querySelectorAll('[data-open-lineup]').forEach(b => b.addEventListener('click', () => onOpen(b.dataset.openLineup)));
  };
  draw();
}

// Two-click lineup spot editor: first where you stand, then where it lands. Calls onChange(spot|null).
// `labels` ({from, to, hintFrom, hintTo}) renames the two modes, e.g. for the game preview.
export function mountSpotEditor(el, { map, spot, nade, side, onChange, labels = {} }) {
  let cur = spot ? structuredClone(spot) : {};
  let level = cur.from?.level || radarsFor(map)[0]?.level || 'main';
  let mode = cur.from && !cur.to ? 'to' : 'from';
  const zoom = { z: 1, x: 0, y: 0 };

  const draw = () => {
    if (!hasRadar(map)) {
      el.innerHTML = '<p class="muted small">Dla tej mapy nie ma jeszcze radaru.</p>';
      return;
    }
    const L = lineupLayer([{ id: 'edit', nade, side, title: 'ten line-up', spot: cur }], level);
    el.innerHTML = `
      <div class="spot-bar">
        ${segmented('smode', [['from', labels.from || '📍 Skąd rzucasz'], ['to', labels.to || `${NADES[nade]?.icon || '💥'} Gdzie ląduje`]], mode)}
        ${levelSwitch(map, level, 'slevel')}
        ${cur.from || cur.to ? '<button type="button" class="btn small ghost" data-act="clear">Wyczyść</button>' : ''}
      </div>
      ${radarBox(map, level, { svg: L.svg, marks: L.marks, cls: 'pick', zoom: true })}
      <p class="muted small"><b class="r-here"></b> ${mode === 'from' ? (labels.hintFrom || 'Kliknij miejsce, w którym stoisz przy rzucie.') : (labels.hintTo || 'Kliknij, gdzie granat ma wylądować.')} Kółko myszy lub dwa palce przybliżają, przeciąganie przesuwa mapę.</p>`;
    bindSegmented(el, 'smode', v => { mode = v; draw(); });
    bindSegmented(el, 'slevel', v => { level = v; draw(); });
    el.querySelector('[data-act="clear"]')?.addEventListener('click', () => { cur = {}; mode = 'from'; onChange(null); draw(); });
    const box = el.querySelector('.radar');
    enableZoom(box, zoom);
    hoverCallouts(box, map, level, el.querySelector('.r-here'));
    box.addEventListener('click', e => {
      if (e.target.closest('.r-zoom')) return;
      cur[mode] = pointFrom(box, e, level);
      if (mode === 'from' && !cur.to) mode = 'to';
      onChange(structuredClone(cur));
      draw();
    });
  };
  draw();
  return {
    // The editor's nade/side/map pickers change what the preview looks like.
    update(next) {
      if (next.map && next.map !== map) {
        map = next.map; cur = {}; mode = 'from'; level = radarsFor(map)[0]?.level || 'main';
        Object.assign(zoom, { z: 1, x: 0, y: 0 });
        onChange(null);
      }
      if (next.nade) nade = next.nade;
      if (next.side) side = next.side;
      draw();
    },
  };
}

// Route editor for roles[index]: click adds the next point (first = start, last = destination),
// drag moves a point, double-click removes it. The other roles are shown dimmed for context.
// With "🧭 Po mapie" on, the line between the points walks the nav mesh (through doors and
// corridors) instead of going straight. Calls onChange(path, track).
export function mountRouteEditor(el, { map, roles, index, lineups = [], onChange }) {
  const path = (roles[index].path || []).map(p => ({ ...p }));
  let track = roles[index].track?.length > 1 ? roles[index].track : null;
  let level = path[0]?.level || dominantLevel(map, { roles, lineups });
  let walking = store.get('cs.navRoute') !== 'off';
  let nav;
  const zoom = { z: 1, x: 0, y: 0 };
  const retrack = () => { track = walking && nav ? walkTrack(nav, path) : null; };
  const changed = () => { retrack(); onChange(path.map(p => ({ ...p })), track); };
  loadNav(map).then(n => {
    nav = n;
    if (walking && nav && path.length > 1 && !track) { changed(); draw(); }
  });

  const draw = () => {
    const view = roles.map((r, i) => i === index ? { ...r, path, track } : r);
    const own = `.rt-pt[data-role="${index}"]`;
    el.innerHTML = `
      <div class="spot-bar">
        ${levelSwitch(map, level, 'elevel')}
        <button type="button" class="btn small" data-act="undo" ${path.length ? '' : 'disabled'}>↶ Cofnij</button>
        <button type="button" class="btn small ghost" data-act="clear" ${path.length ? '' : 'disabled'}>Wyczyść</button>
        ${calloutsFor(map).length ? `<select class="goto" data-act="goto" aria-label="Idź na callout">
          <option value="">${path.length ? '+ idź na callout…' : '+ start z calloutu…'}</option>
          ${calloutOptions(map).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>` : ''}
        <label class="tag-opt" title="Trasa idzie korytarzami z nav mesha gry zamiast prosto"><input type="checkbox" data-act="walk" ${walking ? 'checked' : ''}><span>🧭 Po mapie</span></label>
        <span class="muted small">${path.length ? `${path.length} pkt` : ''}</span>
      </div>
      ${planBox(map, view, lineups, level, { highlight: index, cls: 'pick route-pick', zoom: true })}
      <p class="muted small">${path.length
        ? 'Klikaj kolejne punkty trasy, ostatni to cel. Przeciągnij punkt, żeby go przesunąć, kliknij go dwa razy, żeby usunąć.'
        : 'Kliknij miejsce, z którego gracz startuje.'} Kółko myszy lub dwa palce przybliżają, przeciąganie mapy ją przesuwa.</p>
      <p class="small r-route">${routeLine(map, path, track) || '<span class="muted">Trasa po calloutach pojawi się tutaj.</span>'} <b class="r-here"></b></p>`;
    el.querySelector('[data-act="walk"]').addEventListener('change', e => {
      walking = e.target.checked;
      store.set('cs.navRoute', walking ? null : 'off');
      changed();
      draw();
    });
    bindSegmented(el, 'elevel', v => { level = v; draw(); });
    el.querySelector('[data-act="goto"]')?.addEventListener('change', e => {
      const p = calloutPoint(map, e.target.value, level);
      if (!p) return;
      path.push(p);
      level = p.level;
      changed();
      draw();
    });
    el.querySelector('[data-act="undo"]').onclick = () => { path.pop(); changed(); draw(); };
    el.querySelector('[data-act="clear"]').onclick = () => { path.length = 0; changed(); draw(); };

    const box = el.querySelector('.radar');
    box.querySelectorAll(own).forEach(p => p.classList.add('editable'));
    enableZoom(box, zoom, { ignore: own });
    hoverCallouts(box, map, level, el.querySelector('.r-here'));

    // Dragging one of this role's points (the zoom handler leaves those alone).
    let drag = null;
    box.addEventListener('pointerdown', e => {
      const pt = e.target.closest(own);
      if (!pt) return;
      e.preventDefault();
      e.stopPropagation();
      drag = { k: +pt.dataset.pt, node: pt, moved: false };
      box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = pointFrom(box, e, level);
      Object.assign(path[drag.k], p);
      delete path[drag.k].z; // height came from a callout pick; a moved point finds its own
      drag.node.style.left = `${p.x * 100}%`;
      drag.node.style.top = `${p.y * 100}%`;
      drag.moved = true;
    });
    box.addEventListener('pointerup', () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (moved) { changed(); draw(); }
    });
    box.addEventListener('click', e => {
      if (e.target.closest('.r-zoom') || e.target.closest('.rt-pt')) return;
      path.push(pointFrom(box, e, level));
      changed();
      draw();
    });
    box.addEventListener('dblclick', e => {
      const pt = e.target.closest(own);
      if (!pt) return;
      path.splice(+pt.dataset.pt, 1);
      changed();
      draw();
    });
  };
  draw();
}
