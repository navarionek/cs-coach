// Radar (overhead map) views: picking where a lineup is thrown from and where it lands, and
// drawing lineups as throw lines. Points are 0..1 fractions of the square radar image; Nuke's
// two floors share one coordinate frame, so a throw can start upstairs and land downstairs.
import { team, esc, imageUrl, NADES, segmented, bindSegmented } from './core.js';

const LEVEL_NAMES = { main: 'Góra', lower: 'Dół' };
export const NADE_COLORS = { smoke: '#d5deec', flash: '#fff3a3', molotov: '#ff9a5c', he: '#ff7a8c', decoy: '#b5bfcf' };
const SIDE_COLORS = { T: '#ffb547', CT: '#5ab4ff', any: '#e8ecf3' };

export const radarsFor = map => (team.playbook?.radars || []).filter(r => r.map === map)
  .sort((a, b) => (a.level === 'main' ? -1 : 1) - (b.level === 'main' ? -1 : 1));
export const hasRadar = map => radarsFor(map).length > 0;
const pct = v => `${(v * 100).toFixed(2)}%`;

function levelSwitch(map, level, name = 'rlevel') {
  const rs = radarsFor(map);
  return rs.length > 1 ? segmented(name, rs.map(r => [r.level, LEVEL_NAMES[r.level] || r.level]), level) : '';
}

// SVG lines + HTML markers for a set of lineups on one level.
function overlay(lineups, level, { labels = false } = {}) {
  const withSpot = lineups.filter(l => l.spot?.from || l.spot?.to);
  const lines = withSpot.filter(l => l.spot.from && l.spot.to).map(l => {
    const { from, to } = l.spot;
    const cross = (from.level || 'main') !== (to.level || 'main');
    const c = NADE_COLORS[l.nade] || '#fff';
    return `<line x1="${from.x * 100}" y1="${from.y * 100}" x2="${to.x * 100}" y2="${to.y * 100}"
      stroke="${c}" stroke-width=".45" stroke-dasharray="${cross ? '.6 1.2' : '1.6 .9'}" stroke-linecap="round" opacity=".85" />`;
  }).join('');
  const marks = withSpot.flatMap(l => {
    const out = [];
    const { from, to } = l.spot;
    if (from && (from.level || 'main') === level) {
      out.push(`<span class="r-from" style="left:${pct(from.x)};top:${pct(from.y)};--c:${SIDE_COLORS[l.side] || '#fff'}" title="${esc(l.title)}: skąd"></span>`);
    }
    if (to && (to.level || 'main') === level) {
      out.push(`<button type="button" class="r-to nade-${esc(l.nade)}" data-open-lineup="${esc(l.id)}"
        style="left:${pct(to.x)};top:${pct(to.y)};--c:${NADE_COLORS[l.nade]}" title="${esc(l.title)}">${NADES[l.nade]?.icon || '•'}
        ${labels ? `<span class="r-label">${esc(l.title)}</span>` : ''}</button>`);
    }
    return out;
  }).join('');
  return `<svg class="r-svg" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>${marks}`;
}

function radarImg(map, level) {
  const r = radarsFor(map).find(x => x.level === level) || radarsFor(map)[0];
  return r ? `<img class="r-img" src="${esc(imageUrl(r.path))}" alt="" draggable="false">` : '';
}

// The level a set of lineups mostly lives on (where they land).
function dominantLevel(map, lineups) {
  const counts = {};
  for (const l of lineups) {
    const lv = l.spot?.to?.level || l.spot?.from?.level;
    if (lv) counts[lv] = (counts[lv] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || radarsFor(map)[0]?.level || 'main';
}

// Static radar with throw lines; markers carry data-open-lineup for the caller to bind.
export function radarStatic(map, lineups, { cls = '' } = {}) {
  if (!hasRadar(map) || !lineups.some(l => l.spot)) return '';
  const level = dominantLevel(map, lineups);
  return `<div class="radar ${cls}">${radarImg(map, level)}${overlay(lineups, level)}</div>`;
}

// Interactive map of many lineups with a floor switch; clicking a landing marker calls onOpen.
export function mountLineupMap(el, { map, lineups, onOpen }) {
  let level = dominantLevel(map, lineups);
  const draw = () => {
    const placed = lineups.filter(l => l.spot);
    el.innerHTML = `
      <div class="radar-wrap">
        ${levelSwitch(map, level)}
        <div class="radar big">${radarImg(map, level)}${overlay(placed, level, { labels: true })}</div>
        <p class="muted small">${placed.length ? 'Kropka to miejsce rzutu (kolor strony), ikona to miejsce, gdzie granat ląduje. Kliknij ikonę, żeby otworzyć line-up.' : 'Żaden z tych line-upów nie ma jeszcze zaznaczonego miejsca na mapie. Zaznaczysz je w edytorze line-upu.'}
        ${lineups.length > placed.length && placed.length ? ` ${lineups.length - placed.length} bez miejsca na mapie.` : ''}</p>
      </div>`;
    bindSegmented(el, 'rlevel', v => { level = v; draw(); });
    el.querySelectorAll('[data-open-lineup]').forEach(b => b.addEventListener('click', () => onOpen(b.dataset.openLineup)));
  };
  draw();
}

// Two-click editor: first where you stand, then where it lands. Calls onChange(spot|null).
export function mountSpotEditor(el, { map, spot, nade, side, onChange }) {
  let cur = spot ? structuredClone(spot) : {};
  let level = cur.from?.level || radarsFor(map)[0]?.level || 'main';
  let mode = cur.from && !cur.to ? 'to' : 'from';

  const draw = () => {
    if (!hasRadar(map)) {
      el.innerHTML = '<p class="muted small">Dla tej mapy nie ma jeszcze radaru.</p>';
      return;
    }
    const preview = [{ id: 'edit', nade, side, title: 'ten line-up', spot: cur }];
    el.innerHTML = `
      <div class="spot-bar">
        ${segmented('smode', [['from', '📍 Skąd rzucasz'], ['to', `${NADES[nade]?.icon || '💥'} Gdzie ląduje`]], mode)}
        ${levelSwitch(map, level, 'slevel')}
        ${cur.from || cur.to ? '<button type="button" class="btn small ghost" data-act="clear">Wyczyść</button>' : ''}
      </div>
      <div class="radar pick">${radarImg(map, level)}${overlay(preview, level)}</div>
      <p class="muted small">${mode === 'from' ? 'Kliknij na mapie miejsce, w którym stoisz przy rzucie.' : 'Kliknij, gdzie granat ma wylądować.'}</p>`;
    bindSegmented(el, 'smode', v => { mode = v; draw(); });
    bindSegmented(el, 'slevel', v => { level = v; draw(); });
    el.querySelector('[data-act="clear"]')?.addEventListener('click', () => { cur = {}; mode = 'from'; onChange(null); draw(); });
    const box = el.querySelector('.radar.pick');
    box.addEventListener('click', e => {
      const r = box.getBoundingClientRect();
      const pt = {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
        level,
      };
      pt.x = Math.round(pt.x * 1000) / 1000;
      pt.y = Math.round(pt.y * 1000) / 1000;
      cur[mode] = pt;
      if (mode === 'from' && !cur.to) mode = 'to';
      onChange(structuredClone(cur));
      draw();
    });
  };
  draw();
  return {
    // The editor's nade/side/map pickers change what the preview looks like.
    update(next) {
      if (next.map && next.map !== map) { map = next.map; cur = {}; mode = 'from'; level = radarsFor(map)[0]?.level || 'main'; onChange(null); }
      if (next.nade) nade = next.nade;
      if (next.side) side = next.side;
      draw();
    },
  };
}
