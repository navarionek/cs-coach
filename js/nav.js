// Walking routes on the game's nav mesh (data/nav/<map>.json, built by tools/extract-nav.js): the
// areas bots walk on and the openings between them. A route between two radar points is A* over the
// areas, then the shortest line through the openings (the "funnel"), so it follows corridors and
// doors and goes through the callouts on the way instead of cutting through walls.
const cache = {};

export function loadNav(map) {
  cache[map] ||= fetch(`data/nav/${map}.json`).then(r => r.ok ? r.json() : null).then(raw => raw && prepare(raw)).catch(() => null);
  return cache[map];
}

function prepare({ ov, a }) {
  const areas = a.map(([flat, z, links]) => {
    const poly = [];
    for (let i = 0; i < flat.length; i += 2) poly.push([flat[i], flat[i + 1]]);
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const level = ov.lowerBelow != null && z < ov.lowerBelow ? 'lower' : 'main';
    const ccw = poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) > 0;
    return { poly, z, cx, cy, level, links, ccw, minX: Math.min(...poly.map(p => p[0])), maxX: Math.max(...poly.map(p => p[0])), minY: Math.min(...poly.map(p => p[1])), maxY: Math.max(...poly.map(p => p[1])) };
  });
  // Coarse grid of which areas touch which cell, for "is this spot walkable" checks.
  const grid = new Map();
  areas.forEach((a, i) => {
    for (let gx = Math.floor(a.minX / CELL); gx <= Math.floor(a.maxX / CELL); gx++) {
      for (let gy = Math.floor(a.minY / CELL); gy <= Math.floor(a.maxY / CELL); gy++) {
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  });
  return { ov, areas, grid };
}
const CELL = 256;

// Is (x, y) on an area at about height z?
function onMesh(nav, x, y, z, tol) {
  for (const i of nav.grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) || []) {
    const a = nav.areas[i];
    if (Math.abs(a.z - z) <= tol && x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY && inside(a.poly, x, y)) return true;
  }
  return false;
}

// Straight from a to b without leaving the mesh (sampled every 12 units)?
function clear(nav, a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / 12));
  const tol = 56 + Math.abs(b[2] - a[2]) / 2;
  for (let s = 1; s < n; s++) {
    const t = s / n;
    if (!onMesh(nav, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, tol)) return false;
  }
  return true;
}

// Drop corners the walk doesn't need: from each kept point, jump to the farthest one in plain sight.
function simplify(nav, pts) {
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clear(nav, pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

const toWorld = (ov, p) => [ov.x + p.x * 1024 * ov.scale, ov.y - p.y * 1024 * ov.scale];
const r3 = v => Math.round(v * 1000) / 1000;
const toRadar = (nav, x, y, z) => ({
  x: r3((x - nav.ov.x) / (1024 * nav.ov.scale)), y: r3((nav.ov.y - y) / (1024 * nav.ov.scale)),
  level: nav.ov.lowerBelow != null && z < nav.ov.lowerBelow ? 'lower' : 'main',
});

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// The area under a radar point on its floor. Stacked areas: the one nearest in height to `nearZ`
// (where the route came from), else the lowest. A click on a wall snaps to the nearest area.
function locate(nav, p, nearZ) {
  const [x, y] = toWorld(nav.ov, p);
  const level = p.level || 'main';
  let best = -1, bestScore = Infinity;
  nav.areas.forEach((a, i) => {
    if (a.level !== level || x < a.minX || x > a.maxX || y < a.minY || y > a.maxY || !inside(a.poly, x, y)) return;
    const score = nearZ != null ? Math.abs(a.z - nearZ) : a.z;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  if (best < 0) {
    nav.areas.forEach((a, i) => {
      if (a.level !== level) return;
      const d = Math.hypot(a.cx - x, a.cy - y) + (nearZ != null ? Math.abs(a.z - nearZ) * 0.5 : 0);
      if (d < bestScore) { bestScore = d; best = i; }
    });
    if (bestScore > 400) return null;
  }
  return { i: best, x, y };
}

// A* over areas, cost = 3D distance between area centres (climbing counts a bit more).
function corridor(nav, from, to) {
  const A = nav.areas;
  const h = i => Math.hypot(A[i].cx - A[to].cx, A[i].cy - A[to].cy, A[i].z - A[to].z);
  const g = new Map([[from, 0]]), prev = new Map();
  const heap = [[h(from), from]];
  const push = item => { heap.push(item); let k = heap.length - 1; while (k) { const pk = (k - 1) >> 1; if (heap[pk][0] <= heap[k][0]) break; [heap[pk], heap[k]] = [heap[k], heap[pk]]; k = pk; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; }
    }
    return top;
  };
  const done = new Set();
  while (heap.length) {
    const [, i] = pop();
    if (i === to) break;
    if (done.has(i)) continue;
    done.add(i);
    for (const [j] of A[i].links) {
      const dz = A[j].z - A[i].z;
      const c = g.get(i) + Math.hypot(A[j].cx - A[i].cx, A[j].cy - A[i].cy, dz) + (dz > 0 ? dz * 0.5 : 0);
      if (c < (g.get(j) ?? Infinity)) { g.set(j, c); prev.set(j, i); push([c + h(j), j]); }
    }
  }
  if (!g.has(to)) return null;
  const out = [to];
  while (out[0] !== from) out.unshift(prev.get(out[0]));
  return out;
}

const tri = (a, b, c) => (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;

// Shortest line through the openings of a corridor (simple stupid funnel). Each output point keeps
// the height of the areas it sits between.
function funnel(nav, path, start, end) {
  const A = nav.areas;
  const portals = [[start, start, A[path[0]].z]];
  for (let k = 0; k < path.length - 1; k++) {
    const a = A[path[k]], b = A[path[k + 1]];
    const link = a.links.find(l => l[0] === path[k + 1]);
    const p1 = [link[1], link[2]], p2 = [link[3], link[4]];
    // The portal runs along a's edge in a's winding order, so leaving a through it, the second end
    // is on the left for a counter-clockwise area (world y points up) and on the right otherwise.
    portals.push(a.ccw ? [p2, p1, (a.z + b.z) / 2] : [p1, p2, (a.z + b.z) / 2]);
  }
  portals.push([end, end, A[path.at(-1)].z]);

  const pts = [[...start, portals[0][2]]];
  let apex = start, left = portals[0][0], right = portals[0][1], ai = 0, li = 0, ri = 0;
  for (let i = 1; i < portals.length; i++) {
    const [l, r] = portals[i];
    if (tri(apex, right, r) <= 0) {
      if (same(apex, right) || tri(apex, left, r) > 0) { right = r; ri = i; }
      else { pts.push([...left, portals[li][2]]); apex = left; ai = li; left = right = apex; li = ri = ai; i = ai; continue; }
    }
    if (tri(apex, left, l) >= 0) {
      if (same(apex, left) || tri(apex, right, l) < 0) { left = l; li = i; }
      else { pts.push([...right, portals[ri][2]]); apex = right; ai = ri; left = right = apex; li = ri = ai; i = ai; continue; }
    }
  }
  pts.push([...end, portals.at(-1)[2]]);
  return pts;
}

// Walking line from radar point a to b: [a, …corners…, b] in radar fractions, or null when the
// mesh can't connect them. `nearZ` carries the height between legs; the result says where it ended.
export function walk(nav, a, b, nearZ) {
  const s = locate(nav, a, a.z ?? nearZ);
  const e = s && locate(nav, b, b.z ?? nav.areas[s.i].z);
  if (!s || !e) return null;
  const path = s.i === e.i ? [s.i] : corridor(nav, s.i, e.i);
  if (!path) return null;
  const pts = simplify(nav, funnel(nav, path, [s.x, s.y], [e.x, e.y]))
    .map(([x, y, z]) => ({ ...toRadar(nav, x, y, z), z: Math.round(z) }));
  pts[0] = { ...a, level: a.level || 'main', z: pts[0].z };
  pts[pts.length - 1] = { ...b, level: b.level || 'main', z: pts.at(-1).z };
  return { pts, z: nav.areas[e.i].z };
}

// The whole track for a role's points: each leg walked, straight where the mesh has no way.
export function track(nav, path) {
  if (!nav || path.length < 2) return null;
  const out = [{ ...path[0], level: path[0].level || 'main' }];
  let z = null;
  for (let k = 0; k < path.length - 1; k++) {
    const w = walk(nav, path[k], path[k + 1], z);
    z = w?.z ?? null;
    const leg = w ? w.pts.slice(1) : [{ ...path[k + 1], level: path[k + 1].level || 'main' }];
    // Corners a hair apart (both ends of a narrow door) read as one.
    leg.forEach((p, j) => {
      const last = out.at(-1);
      if (j < leg.length - 1 && Math.hypot(p.x - last.x, p.y - last.y) < 0.004) return;
      out.push(p);
    });
  }
  return out;
}
