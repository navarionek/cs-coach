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

// The callout under a radar point. Places are stacked on Nuke (Heaven and Rafters over A site), and
// a radar point has no height, so the ground floor wins: of the zones whose bottom is near the
// lowest one, the smallest (a hut inside a site is the hut).
export function placeAt(map, p) {
  if (!p) return null;
  const level = p.level || 'main';
  const hits = [];
  for (const c of calloutsFor(map)) {
    for (const z of c.zones) if (z.level === level && inside(z.poly, p.x, p.y)) hits.push({ c, z0: z.z0, a: area(z.poly) });
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
  return { x: l.x, y: l.y, level: l.level };
}

// A route as callouts, repeats collapsed; points outside any zone are skipped.
export function routePlaces(map, path) {
  const out = [];
  for (const p of path || []) {
    const c = placeAt(map, p);
    if (c && out.at(-1)?.id !== c.id) out.push(c);
  }
  return out;
}
export const routeText = (map, path) => routePlaces(map, path).map(c => c.name).join(' → ');

// Callouts for a picker: sites and spawns first, then by name.
export function calloutOptions(map) {
  const rank = c => /^Bombsite/.test(c.id) ? 0 : /Spawn$/.test(c.id) ? 1 : 2;
  return [...calloutsFor(map)].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
