// Builds js/callouts.js: every env_cs_place (the callout zones the game shows next to your name)
// with its physics hulls flattened to radar polygons.
// node tools/extract-callouts.js <entsDir> <physDir> <csgo_english.txt> js/calloutdata.js
// entsDir/<short>: decompiled maps/de_<short>/entities/default_ents.vents_c (Source2Viewer-CLI -d);
// physDir/<short>.txt: Source2Viewer-CLI -i de_<short>.vpk -f maps/de_<short>/entities/ -e vmdl_c -b PHYS;
// csgo_english.txt: resource/csgo_english.txt from pak01_dir.vpk.
const fs = require('fs');
const path = require('path');
const [entsDir, physDir, locFile, outFile] = process.argv.slice(2);

const OV = {
  de_ancient: { x: -2953, y: 2164, scale: 5 },
  de_inferno: { x: -2087, y: 3870, scale: 4.9 },
  de_nuke: { x: -3453, y: 2887, scale: 7, lowerBelow: -495 },
};

// Game names, a bit shorter where the team says it shorter.
const loc = {};
for (const m of fs.readFileSync(locFile, 'utf8').matchAll(/^\s*"([^"]+)"\s+"([^"]*)"/gm)) loc[m[1]] = m[2];
const SHORT = { 'Bombsite A': 'A site', 'Bombsite B': 'B site', 'CT Start': 'CT spawn', 'T Start': 'T spawn' };
const label = id => { const n = loc[id] || id.replace(/([a-z])([A-Z])/g, '$1 $2'); return SHORT[n] || n; };

const r3 = v => Math.round(v * 1000) / 1000;

function hulls(dump) {
  // file path -> list of hulls (arrays of [x,y,z] model-local)
  const out = {};
  const parts = dump.split(/^\[\d+\/\d+\] /m).slice(1);
  for (const p of parts) {
    const file = p.slice(0, p.indexOf('\n')).trim().replace(/_c$/, '');
    const list = [];
    for (const m of p.matchAll(/m_VertexPositions\s*=\s*#\[([^\]]*)\]/g)) {
      const bytes = Buffer.from(m[1].trim().split(/\s+/).map(h => parseInt(h, 16)));
      const pts = [];
      for (let i = 0; i + 12 <= bytes.length; i += 12) pts.push([bytes.readFloatLE(i), bytes.readFloatLE(i + 4), bytes.readFloatLE(i + 8)]);
      list.push(pts);
    }
    if (/m_meshes\s*=\s*\[\s*\{/.test(p)) console.error('mesh shape (ignored):', file);
    out[file] = list;
  }
  return out;
}

function convex(pts) {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of s) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
  for (const p of s.reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
const area = poly => Math.abs(poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  poly.forEach((p, i) => { const q = poly[(i + 1) % poly.length]; const c = p[0] * q[1] - q[0] * p[1]; a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; });
  return [cx / (3 * a), cy / (3 * a)];
}

const out = {};
for (const short of ['ancient', 'inferno', 'nuke']) {
  const map = `de_${short}`;
  const ov = OV[map];
  const H = hulls(fs.readFileSync(path.join(physDir, `${short}.txt`), 'utf8'));
  const places = {};
  for (const b of fs.readFileSync(path.join(entsDir, short), 'utf8').split(/====\d+====/)) {
    if (!/classname\s+"env_cs_place"/.test(b)) continue;
    const id = b.match(/place_name\s+"([^"]*)"/)[1];
    const o = b.match(/origin\s+\[\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]/).slice(1).map(Number);
    const model = b.match(/model\s+resource_name:"([^"]+)"/)[1];
    const hs = H[model];
    if (!hs?.length) { console.error('no hulls', map, id, model); continue; }
    for (const h of hs) {
      const w = h.map(([x, y, z]) => [x + o[0], y + o[1], z + o[2]]);
      const zs = w.map(p => p[2]);
      const zmin = Math.min(...zs), zmax = Math.max(...zs);
      const level = ov.lowerBelow != null && (zmin + zmax) / 2 < ov.lowerBelow ? 'lower' : 'main';
      const poly = convex(w.map(([x, y]) => [(x - ov.x) / (1024 * ov.scale), (ov.y - y) / (1024 * ov.scale)]));
      (places[id] ||= { id, name: label(id), zones: [] }).zones.push({ level, z: [Math.round(zmin), Math.round(zmax)], poly });
    }
  }
  out[map] = Object.values(places).map(p => {
    // Label on the biggest zone of each floor.
    const byLevel = {};
    for (const z of p.zones) if (!byLevel[z.level] || area(z.poly) > area(byLevel[z.level].poly)) byLevel[z.level] = z;
    return {
      id: p.id, name: p.name,
      labels: Object.values(byLevel).map(z => { const [x, y] = centroid(z.poly); return { x: r3(x), y: r3(y), level: z.level, a: Math.round(area(z.poly) * 1e4) / 1e4 }; }),
      zones: p.zones.map(z => ({ level: z.level, z0: z.z[0], poly: z.poly.map(([x, y]) => [r3(x), r3(y)]) })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  console.error(map, out[map].length, 'places', out[map].reduce((a, p) => a + p.zones.length, 0), 'zones');
  if (ov.lowerBelow != null) for (const p of Object.values(places)) console.error('  ', p.id, p.zones.map(z => `${z.level}${z.z}`).join(' '));
}

fs.writeFileSync(outFile, `// Callout zones (env_cs_place in maps/<map>/entities, the place name the game shows next to a
// player). Each zone is a physics hull of that entity flattened to a radar polygon (0..1 fractions,
// like every other point); names come from resource/csgo_english.txt, labels sit on the biggest zone
// of each floor (a = its area), z0 is a zone's bottom height in the world (stacked places on Nuke). Generated from the game files with Source 2 Viewer CLI, don't edit.
export const CALLOUTS = ${JSON.stringify(out)};
`);
