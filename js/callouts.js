// Callouts: the game's own place zones on the radar. Which callout a point is in, where a callout's
// centre is, and a route read as a chain of callouts ("T spawn → Banana → B site").
import { CALLOUTS } from './calloutdata.js';

export const calloutsFor = map => CALLOUTS[map] || [];
export const callout = (map, id) => calloutsFor(map).find(c => c.id === id) || null;

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
const area = poly => Math.abs(poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

// The callout under a radar point. Places are stacked on Nuke (Heaven and Rafters over A site).
// Points of a walked track know their height (z) and get the zone they're in; a clicked point
// doesn't, so the ground floor wins: of the zones whose bottom is near the lowest one, the
// smallest (a hut inside a site is the hut).
export function placeAt(map, p) {
  if (!p) return null;
  const level = p.level || 'main';
  let hits = [];
  for (const c of calloutsFor(map)) {
    for (const z of c.zones) if (z.level === level && inside(z.poly, p.x, p.y)) hits.push({ c, z0: z.z0, z1: z.z1, a: area(z.poly) });
  }
  if (p.z != null) {
    const near = hits.filter(h => p.z >= h.z0 - 40 && p.z <= h.z1);
    if (near.length) hits = near;
  }
  if (!hits.length) return null;
  const floor = Math.min(...hits.map(h => h.z0));
  return hits.filter(h => h.z0 - floor < 64).sort((a, b) => a.a - b.a)[0].c;
}

// Where to put a point that means "go to this callout": its label spot on the given floor, else any.
export function calloutPoint(map, id, level) {
  const c = callout(map, id);
  if (!c) return null;
  const l = c.labels.find(x => x.level === level) || c.labels[0];
  // Height of the zone the label sits in, so a route to Heaven ends up in Heaven, not below it.
  const z = c.zones.find(zn => zn.level === l.level && inside(zn.poly, l.x, l.y));
  return z ? { x: l.x, y: l.y, level: l.level, z: z.z0 + 32 } : { x: l.x, y: l.y, level: l.level };
}

// A route as callouts, repeats collapsed. The line is sampled between its points, so callouts it
// only walks through count too; a brief clip of a zone (under ~2% of the map) doesn't.
export function routePlaces(map, path) {
  const pts = path || [];
  const runs = [];
  const add = (c, d) => {
    if (!c) return;
    if (runs.at(-1)?.c.id === c.id) runs.at(-1).d += d;
    else runs.push({ c, d });
  };
  pts.forEach((p, k) => {
    const q = pts[k + 1];
    if (!q) { add(placeAt(map, p), 1); return; }
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.ceil(len / 0.004));
    for (let s = 0; s < n; s++) {
      const t = s / n;
      const z = p.z != null && q.z != null ? p.z + (q.z - p.z) * t : undefined;
      add(placeAt(map, { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, level: t < 0.5 ? p.level : q.level, z }), len / n);
    }
  });
  const keep = runs.filter((r, i) => i === 0 || i === runs.length - 1 || r.d >= 0.02);
  return keep.filter((r, i) => i === 0 || keep[i - 1].c.id !== r.c.id).map(r => r.c);
}
export const routeText = (map, path) => routePlaces(map, path).map(c => c.name).join(' → ');

// Callouts for a picker: sites and spawns first, then by name.
export function calloutOptions(map) {
  const rank = c => /^Bombsite/.test(c.id) ? 0 : /Spawn$/.test(c.id) ? 1 : 2;
  return [...calloutsFor(map)].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
