// Builds data/nav/<map>.json from the game's nav meshes (maps/<map>.nav in maps/<map>.vpk, pulled out
// with Source2Viewer-CLI -i de_x.vpk -f maps/de_x.nav -o <dir>/de_x.nav). The route editor walks it.
//   node tools/extract-nav.js <dir with de_*.nav> data/nav
// Reader after awpy's crates/awpy/src/nav.rs (MIT): nav v30-36, v36 has two KV3 blobs we skip.
//
// Output per map, world units rounded to integers:
//   { ov, a: [[polygon x,y,…], z, [[neighbour index, portal x1,y1,x2,y2], …]], … }
// The portal is the part of the shared edge both areas touch, pulled in from the walls a bit.
const fs = require('fs');
const path = require('path');

const OV = {
  de_ancient: { x: -2953, y: 2164, scale: 5 },
  de_inferno: { x: -2087, y: 3870, scale: 4.9 },
  de_nuke: { x: -3453, y: 2887, scale: 7, lowerBelow: -495 },
};
const WALL = 14; // keep routes this far from portal ends

function parseNav(buf) {
  let o = 0;
  const u8 = () => buf.readUInt8(o++);
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const i32 = () => { const v = buf.readInt32LE(o); o += 4; return v; };
  const f32 = () => { const v = buf.readFloatLE(o); o += 4; return v; };
  const skip = n => { o += n; };
  const kv3 = () => {
    o = (o + 7) & ~7;
    const magic = u32();
    if ((magic & 0xffffff00) >>> 0 !== 0x4b563300) throw new Error(`kv3 magic at ${o - 4}`);
    const ver = magic & 0xff;
    skip(16);
    const method = u32();
    skip(24);
    const uncTotal = i32(), cmpTotal = i32(), nBlocks = i32(), nBlobs = i32();
    let blockCmp = 0;
    if (ver >= 4) { skip(4); blockCmp = i32(); }
    let unc1 = 0, cmp1 = 0, unc2 = 0, cmp2 = 0;
    if (ver >= 5) { unc1 = i32(); cmp1 = i32(); unc2 = i32(); cmp2 = i32(); skip(32); }
    if (nBlocks || nBlobs) throw new Error('kv3 with blocks');
    skip((ver >= 5 ? (method ? cmp1 + cmp2 : unc1 + unc2) : (method ? cmpTotal : uncTotal)) + blockCmp);
  };

  if (u32() !== 0xfeedface) throw new Error('not a nav file');
  const version = u32();
  u32(); u32();
  if (version < 31 || version > 36) throw new Error(`nav version ${version}`);
  if (version >= 36) kv3();
  const corners = [];
  for (let i = 0, n = u32(); i < n; i++) corners.push([f32(), f32(), f32()]);
  const polys = [];
  for (let i = 0, n = u32(); i < n; i++) {
    const p = [];
    for (let j = 0, k = u8(); j < k; j++) p.push(u32());
    if (version >= 35) skip(4);
    polys.push(p);
  }
  if (version >= 32) skip(4);
  if (version >= 35) for (let i = 0, n = u32(); i < n; i++) { while (buf[o] !== 0) o++; o++; skip(48); }
  if (version >= 36) kv3();
  const areas = [];
  for (let i = 0, n = u32(); i < n; i++) {
    const id = u32();
    skip(9);
    const poly = polys[u32()].map(c => corners[c]);
    skip(4);
    const links = poly.map(() => {
      const ids = [];
      for (let j = 0, c = u32(); j < c; j++) { ids.push(u32()); u32(); }
      return ids;
    });
    skip(5);
    skip(4 * u32());
    skip(4 * u32());
    areas.push({ id, poly, links });
  }
  return areas;
}

// The stretch of edge a→b (2D) that `other` also covers, shrunk by WALL at both ends.
function portal(a, b, other) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ts = other.map(p => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len));
  let t0 = Math.max(0, Math.min(...ts)), t1 = Math.min(1, Math.max(...ts));
  if (t1 < t0) { const m = (Math.min(1, Math.max(0, (t0 + t1) / 2))); t0 = t1 = m; }
  const m = WALL / len;
  if (t1 - t0 > 2 * m) { t0 += m; t1 -= m; } else { t0 = t1 = (t0 + t1) / 2; }
  return [a[0] + dx * t0, a[1] + dy * t0, a[0] + dx * t1, a[1] + dy * t1];
}

const [src, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
for (const map of Object.keys(OV)) {
  const areas = parseNav(fs.readFileSync(path.join(src, `${map}.nav`)));
  const index = new Map(areas.map((a, i) => [a.id, i]));
  const R = Math.round;
  const a = areas.map(ar => {
    const z = ar.poly.reduce((s, p) => s + p[2], 0) / ar.poly.length;
    const links = [];
    ar.poly.forEach((p, e) => {
      const q = ar.poly[(e + 1) % ar.poly.length];
      for (const nid of ar.links[e]) {
        const j = index.get(nid);
        if (j == null) continue;
        links.push([j, ...portal(p, q, areas[j].poly).map(R)]);
      }
    });
    return [ar.poly.flatMap(p => [R(p[0]), R(p[1])]), R(z), links];
  });
  const file = path.join(outDir, `${map}.json`);
  fs.writeFileSync(file, JSON.stringify({ ov: OV[map], a }));
  console.log(map, areas.length, 'areas', fs.statSync(file).size, 'bytes');
}
