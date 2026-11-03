#!/usr/bin/env node
// Granko Recorder: records grenade lineups straight from CS2 into Granko.
//
//   node recorder/granko-recorder.js [de_ancient|de_inferno|de_nuke]
//
// Starts CS2 offline on the map (unless it's already running with -condebug), types `exec granko`
// into the console, then follows game/csgo/console.log:
//   F6  stand on the throw spot and aim: saves position + aim (setpos/setang), an "aim" screenshot
//       and the throw spot on the radar as a new lineup
//   F7  after the throw: adds a "result" screenshot (the bloomed smoke, the flash…)
//   F8  standing where the grenade landed: marks the landing spot on the radar
//   F5  back to the last F6 spot to throw again
// CS2 has no remote console, so the keys run tiny cfg files whose `execing <name>` and `getpos`
// lines show up in the log (echo output doesn't).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const SUPABASE_URL = 'https://qnhzbnofloghyhbmkvnq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wDsMbOBSA67oTBVOcan80g_mLhKrnqW';
const HERE = __dirname;
// Radar calibration from resource/overviews/<map>.txt: world = pos + fraction * 1024 * scale.
const OVERVIEWS = {
  de_ancient: { name: 'Ancient', x: -2953, y: 2164, scale: 5 },
  de_inferno: { name: 'Inferno', x: -2087, y: 3870, scale: 4.9 },
  de_nuke: { name: 'Nuke', x: -3453, y: 2887, scale: 7, lowerBelow: -495 },
};

const config = (() => {
  const file = path.join(HERE, 'config.json');
  if (!fs.existsSync(file)) {
    console.error(`Brak ${file}. Skopiuj config.example.json jako config.json i wpisz hasło drużyny oraz swój nick.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
})();
// --agent: background mode started with Windows; waits for jobs from the page instead of starting CS2.
const AGENT = process.argv.includes('--agent');
const startMap = process.argv.slice(2).find(a => !a.startsWith('--')) || 'de_ancient';
if (!OVERVIEWS[startMap]) {
  console.error(`Nieznana mapa ${startMap}. Dostępne: ${Object.keys(OVERVIEWS).join(', ')}`);
  process.exit(1);
}

// --- game install ---

function steamPath() {
  const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8' });
  return out.match(/SteamPath\s+REG_SZ\s+(.+)/)[1].trim();
}
function cs2Path() {
  if (config.cs2Path) return config.cs2Path;
  const steam = steamPath();
  const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
  const libs = [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map(m => m[1].replace(/\\\\/g, '\\'));
  for (const lib of libs) {
    if (fs.existsSync(path.join(lib, 'steamapps', 'appmanifest_730.acf'))) {
      return path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive');
    }
  }
  throw new Error('Nie znalazłem CS2 w bibliotekach Steama (ustaw cs2Path w config.json).');
}
const GAME = cs2Path();
const CSGO = path.join(GAME, 'game', 'csgo');
const LOG = path.join(CSGO, 'console.log');
const CFG = path.join(CSGO, 'cfg');

function cs2CommandLine() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='cs2.exe'\").CommandLine"], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

// --- cfg files the in-game keys run ---

function writeCfgs() {
  const w = (name, lines) => fs.writeFileSync(path.join(CFG, `${name}.cfg`), lines.join('\n') + '\n');
  w('granko', [
    '// Granko Recorder: offline practice for recording lineups',
    'sv_cheats 1', 'bot_kick', 'mp_warmup_start', 'mp_warmup_pausetimer 1', 'mp_freezetime 0',
    'mp_buy_anywhere 1', 'mp_buytime 99999', 'mp_maxmoney 60000', 'mp_startmoney 60000', 'mp_afterroundmoney 60000',
    'sv_infinite_ammo 1', 'ammo_grenade_limit_total 5', 'sv_grenade_trajectory_prac_pipreview 1',
    // Screenshots keep the crosshair but drop the rest of the HUD and the gun.
    'cl_draw_only_deathnotices 1', 'r_drawviewmodel 0',
    'bind F5 "exec grankoback"', 'bind F6 "exec grankopos"', 'bind F7 "exec grankoshot"', 'bind F8 "exec grankoland"',
    // F9 is pressed by the recorder itself to run jobs sent from the Granko page.
    'bind F9 "exec grankojob"',
    'getpos',
  ]);
  w('grankopos', ['getpos']);
  w('grankoshot', ['getpos']);
  w('grankoland', ['getpos']);
  w('grankooff', ['cl_draw_only_deathnotices 0', 'r_drawviewmodel 1']);
  if (!fs.existsSync(path.join(CFG, 'grankoback.cfg'))) w('grankoback', ['getpos']);
}

// --- Granko API ---

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json', 'content-profile': 'cs' },
    body: JSON.stringify({ k: config.teamKey, ...args }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
  return body;
}

async function upload(file) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/cs-upload`, {
    method: 'POST',
    headers: { 'x-team-key': config.teamKey, 'content-type': 'image/jpeg' },
    body: fs.readFileSync(file),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.path;
}

function grab() {
  const file = path.join(os.tmpdir(), `granko-${Date.now()}.jpg`);
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'grab.ps1'), '-Out', file]);
  return file;
}
const beep = kind => spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'keys.ps1'), '-Beep', kind], { stdio: 'ignore' });
const typeExec = cfg => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'keys.ps1'), '-Exec', cfg]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- state ---

const state = { map: startMap, side: null, draft: null, memberId: null };
const round3 = v => Math.round(v * 1000) / 1000;

function toRadar(map, x, y, z) {
  const o = OVERVIEWS[map];
  if (!o) return null;
  return {
    x: round3((x - o.x) / (1024 * o.scale)),
    y: round3((o.y - y) / (1024 * o.scale)),
    level: o.lowerBelow != null && z < o.lowerBelow ? 'lower' : 'main',
  };
}

// Saves run one after another, so F6/F7/F8 pressed quickly still land in order.
let queue = Promise.resolve();
const enqueue = job => { queue = queue.then(job).catch(err => { beep('err'); console.error('  ✗', err.message); }); };

async function save() {
  state.draft.id = await rpc('save_lineup', { l: state.draft });
}

function onPos(p) {
  const o = OVERVIEWS[state.map];
  if (!o) { beep('err'); console.log(`  ✗ Mapa ${state.map} nie ma kalibracji radaru.`); return; }
  const setpos = `setpos ${p.x} ${p.y} ${p.z};setang ${p.pitch} ${p.yaw} 0`;
  fs.writeFileSync(path.join(CFG, 'grankoback.cfg'), setpos + '\n');
  const time = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  state.draft = {
    map: state.map, side: state.side || 'any', nade: 'smoke', throw: 'left',
    title: `Nowy line-up ${o.name} ${time}`,
    description: 'Nagrane w grze (Granko Recorder). Uzupełnij nazwę, granat i opis.',
    images: [], spot: { from: toRadar(state.map, p.x, p.y, p.z) }, setpos, created_by: state.memberId,
  };
  enqueue(async () => {
    await sleep(150);
    const img = await upload(grab());
    state.draft.images.push({ path: img, caption: 'aim' });
    await save();
    beep('ok');
    console.log(`  ✓ F6 nowy line-up: ${state.draft.title} (${setpos})`);
  });
}

function onShot() {
  if (!state.draft) { beep('err'); console.log('  ✗ F7 bez F6: najpierw zapisz pozycję.'); return; }
  enqueue(async () => {
    const img = await upload(grab());
    state.draft.images.push({ path: img, caption: 'result' });
    await save();
    beep('ok');
    console.log('  ✓ F7 dodany screen efektu');
  });
}

function onLand(p) {
  if (!state.draft) { beep('err'); console.log('  ✗ F8 bez F6: najpierw zapisz pozycję.'); return; }
  state.draft.spot.to = toRadar(state.map, p.x, p.y, p.z);
  enqueue(async () => {
    await save();
    beep('ok');
    console.log('  ✓ F8 zaznaczone miejsce lądowania');
  });
}

// --- remote jobs from the Granko page ("Podgląd" tab) ---
// The radar gives x/y but no height, so every position the game reports is kept per map in
// zcache.json; a teleport drops the player from just above the nearest known spot.

const ZCACHE = path.join(HERE, 'zcache.json');
const zcache = fs.existsSync(ZCACHE) ? JSON.parse(fs.readFileSync(ZCACHE, 'utf8')) : {};
const DEFAULT_DROP = { de_ancient: 300, de_inferno: 350, de_nuke: -150, de_nuke_lower: -560 };
// Spawn points from the map files (js/mapdata.js) are known-good heights from the start.
const SPAWN_SAMPLES = (() => {
  try {
    const src = fs.readFileSync(path.join(HERE, '..', 'js', 'mapdata.js'), 'utf8');
    const spawns = JSON.parse(src.match(/export const SPAWNS = (\{.*\});/s)[1]);
    return Object.fromEntries(Object.entries(spawns).map(([m, s]) => [m, [...s.T, ...s.CT].map(p => p.world)]));
  } catch { return {}; }
})();

function addSample(p) {
  const list = (zcache[state.map] ||= []);
  if (list.some(s => Math.hypot(s[0] - p.x, s[1] - p.y) < 64 && Math.abs(s[2] - p.z) < 48)) return;
  list.push([Math.round(p.x), Math.round(p.y), Math.round(p.z)]);
  fs.writeFileSync(ZCACHE, JSON.stringify(zcache));
}

function dropHeight(map, x, y, level) {
  const o = OVERVIEWS[map];
  const lower = o.lowerBelow != null && level === 'lower';
  const samples = [...(zcache[map] || []), ...(SPAWN_SAMPLES[map] || [])].filter(s => o.lowerBelow == null || (s[2] < o.lowerBelow) === lower);
  const near = samples.map(s => ({ s, d: Math.hypot(s[0] - x, s[1] - y) })).sort((a, b) => a.d - b.d);
  if (near[0] && near[0].d < 400) return near[0].s[2] + 72;
  const around = near.filter(n => n.d < 2000);
  if (around.length) return Math.max(...around.map(n => n.s[2])) + 150;
  return DEFAULT_DROP[lower ? `${map}_lower` : map] ?? 300;
}

let jobWaiter = null;
function jobPos(p) { jobWaiter?.(p); jobWaiter = null; }

// Writes the commands into grankojob.cfg and presses F9; resolves with the getpos that ends it.
async function runJob(lines, timeoutMs = 4000) {
  fs.writeFileSync(path.join(CFG, 'grankojob.cfg'), [...lines, 'getpos'].join('\n') + '\n');
  for (let i = 0; i < 2; i++) {
    const got = new Promise(resolve => { jobWaiter = resolve; setTimeout(() => resolve(null), timeoutMs); });
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'keys.ps1'), '-Vk', '0x78']);
    const p = await got;
    if (p) return p;
  }
  throw new Error('Gra nie wykonała polecenia (otwarte menu albo konsola?)');
}

async function changeMap(map) {
  console.log(`  → zmiana mapy na ${map}`);
  const from = logSize();
  fs.writeFileSync(path.join(CFG, 'grankojob.cfg'), `map ${map}\n`);
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'keys.ps1'), '-Vk', '0x78']);
  if (!await waitFor(new RegExp(`Host activate: Loading \\(${map}\\)`), 120e3, from)) throw new Error(`Nie udało się załadować ${map}`);
  state.map = map;
  await sleep(8000);
  await runJob(['exec granko'], 6000);
  cs2.ready = true;
}

async function teleportJob(payload) {
  const { map, at, look } = payload;
  const o = OVERVIEWS[map];
  if (!o) throw new Error(`Mapa ${map} nie ma kalibracji radaru`);
  const world = f => ({ x: Math.round(o.x + f.x * 1024 * o.scale), y: Math.round(o.y - f.y * 1024 * o.scale) });
  const p = world(at);
  const z = Math.round(dropHeight(map, p.x, p.y, at.level || 'main'));
  let yaw = 90;
  if (look) {
    const q = world(look);
    yaw = Math.round(Math.atan2(q.y - p.y, q.x - p.x) * 1800 / Math.PI) / 10;
  }
  await runJob([`setpos ${p.x} ${p.y} ${z}`, `setang 2 ${yaw} 0`]);
  await sleep(1300); // fall to the floor
  const landed = await runJob([]);
  await sleep(250);
  const image = await upload(grab());
  const setpos = `setpos ${landed.x} ${landed.y} ${landed.z};setang ${landed.pitch} ${landed.yaw} 0`;
  return { image, setpos, z: landed.z, map, at: toRadar(map, landed.x, landed.y, landed.z) };
}

// --- CS2 process state ---
// off: not running · game: a normal session (no -condebug, never touched) · practice: our offline
// session, cfg not loaded yet · ready: practice with `exec granko` done (F5-F9 bound).

const cs2 = { pid: null, practice: false, ready: false };

function cs2Pid() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq cs2.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const m = out.match(/"cs2\.exe","(\d+)"/i);
    return m ? +m[1] : null;
  } catch { return null; }
}

function refreshCs2() {
  const pid = cs2Pid();
  if (pid !== cs2.pid) {
    cs2.pid = pid;
    cs2.ready = false;
    cs2.practice = !!pid && cs2CommandLine().includes('-condebug');
  }
}
const cs2Status = () => (!cs2.pid ? 'off' : !cs2.practice ? 'game' : cs2.ready ? 'ready' : 'practice');

async function launchCs2(map) {
  const from = logSize();
  const steam = path.join(steamPath(), 'steam.exe');
  spawn(steam, ['-applaunch', '730', '-condebug', '-novid', '+map', map], { detached: true, stdio: 'ignore' }).unref();
  if (!await waitFor(/Host activate: Loading/, 180e3, from)) throw new Error('Gra nie załadowała mapy w 3 minuty');
  state.map = map;
  await sleep(8000); // let the player spawn before the cheats/bot commands
  refreshCs2();
}

// Types `exec granko` until the log confirms it (the console key can land while a menu is open).
async function setupPractice() {
  for (let i = 0; i < 3; i++) {
    const from = logSize();
    typeExec('granko');
    if (await waitFor(/execing granko\r?\n/, 5000, from)) { cs2.ready = true; return; }
  }
  throw new Error('Nie udało się wpisać exec granko (otwarte menu w grze?)');
}

// CS2 in practice mode on `map` with the recorder's cfg loaded; a normal game is never touched.
async function ensurePractice(map) {
  refreshCs2();
  if (cs2.pid && !cs2.practice) throw new Error('CS2 jest włączony normalnie (gra). Zamknij go, żeby włączyć trening.');
  if (!cs2.pid) {
    console.log(`  → uruchamiam CS2 offline na ${map}`);
    await launchCs2(map);
  }
  if (!cs2.ready) await setupPractice();
  if (map && state.map !== map) await changeMap(map);
}

const JOBS = {
  async teleport(p) {
    await ensurePractice(p.map);
    return teleportJob(p);
  },
  async start(p) {
    await ensurePractice(p.map || state.map);
    return { status: cs2Status(), map: state.map };
  },
  async quit() {
    refreshCs2();
    if (!cs2.pid) return { status: 'off' };
    if (!cs2.practice) throw new Error('CS2 jest w normalnej grze, nie zamykam go.');
    await runJob(['cl_draw_only_deathnotices 0', 'r_drawviewmodel 1'], 3000).catch(() => {});
    fs.writeFileSync(path.join(CFG, 'grankojob.cfg'), 'quit\n');
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'keys.ps1'), '-Vk', '0x78']);
    for (let i = 0; i < 20 && cs2Pid(); i++) await sleep(500);
    refreshCs2();
    return { status: cs2Status() };
  },
};

// Heartbeat + job queue. Polls fast while CS2 runs, slower when the PC just sits there.
const agentInfo = () => ({ cs2: cs2Status(), side: state.side, mode: AGENT ? 'agent' : 'manual', version: 2 });

function agentLoop() {
  let lastCheck = 0;
  // Separate heartbeat, so the page still sees the PC while a long job (cold CS2 start) runs.
  setInterval(() => { rpc('agent_ping', { p_map: state.map, p_info: agentInfo() }).catch(() => {}); }, 3000);
  const tick = async () => {
    try {
      if (Date.now() - lastCheck > 4000) { refreshCs2(); lastCheck = Date.now(); }
      const job = await rpc('agent_take', {
        p_map: state.map,
        p_info: agentInfo(),
      });
      if (job) {
        console.log(`  ⇢ zadanie ze strony #${job.id}: ${job.kind}`);
        try {
          const run = JOBS[job.kind];
          if (!run) throw new Error(`Nieznane zadanie ${job.kind}`);
          const result = await run(job.payload || {});
          await rpc('agent_finish', { job_id: job.id, ok: true, p_result: result });
          if (job.kind === 'teleport') beep('ok');
          console.log(`  ✓ #${job.id} gotowe`);
        } catch (err) {
          await rpc('agent_finish', { job_id: job.id, ok: false, p_result: { error: err.message } }).catch(() => {});
          beep('err');
          console.log(`  ✗ #${job.id}: ${err.message}`);
        }
        lastCheck = 0;
      }
    } catch (err) {
      console.log(`  (brak połączenia z Granko: ${err.message})`);
    }
    setTimeout(tick, cs2.pid ? 900 : 2500);
  };
  tick();
}

// --- console.log follower ---

function follow() {
  let offset = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
  let pending = null;
  let carry = '';
  setInterval(() => {
    if (!fs.existsSync(LOG)) return;
    const size = fs.statSync(LOG).size;
    if (size < offset) offset = 0; // log was truncated by a restart
    if (size === offset) return;
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (carry + buf.toString('utf8')).split(/\r?\n/);
    carry = lines.pop();
    for (const line of lines) {
      let m;
      if ((m = line.match(/Host activate: Loading \((\w+)\)/))) {
        state.map = m[1];
        console.log(`Mapa: ${state.map}`);
      } else if ((m = line.match(/<\[U:1:\d+\]><(CT|TERRORIST|T)>/))) {
        state.side = m[1] === 'CT' ? 'CT' : 'T';
      } else if ((m = line.match(/execing (grankopos|grankoshot|grankoland|grankojob)\b/))) {
        pending = m[1];
      } else if (/execing granko\b/.test(line)) {
        cs2.ready = true;
      } else if ((m = line.match(/setpos\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+);\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)/))) {
        const p = { x: +(+m[1]).toFixed(2), y: +(+m[2]).toFixed(2), z: +(+m[3]).toFixed(2), pitch: +(+m[4]).toFixed(2), yaw: +(+m[5]).toFixed(2) };
        addSample(p);
        if (pending === 'grankopos') onPos(p);
        else if (pending === 'grankoshot') onShot();
        else if (pending === 'grankoland') onLand(p);
        else if (pending === 'grankojob') jobPos(p);
        pending = null;
      }
    }
  }, 200);
}

const logSize = () => (fs.existsSync(LOG) ? fs.statSync(LOG).size : 0);

async function waitFor(re, timeoutMs, start = logSize()) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(1000);
    if (!fs.existsSync(LOG)) continue;
    const size = fs.statSync(LOG).size;
    if (size < start) start = 0; // a fresh CS2 start recreates console.log
    if (size <= start) continue;
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    if (re.test(buf.toString('utf8'))) return true;
  }
  return false;
}

// When the agent (re)starts next to a running CS2, the current map and whether `exec granko` already
// ran this session are in the tail of console.log.
function primeFromLog() {
  if (!cs2.pid || !fs.existsSync(LOG)) return;
  const size = fs.statSync(LOG).size;
  const from = Math.max(0, size - 400e3);
  const fd = fs.openSync(LOG, 'r');
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const loads = [...text.matchAll(/Host activate: Loading \((\w+)\)/g)];
  const last = loads.at(-1);
  if (!last) return;
  state.map = last[1];
  if (cs2.practice && /execing granko\r?\n/.test(text.slice(last.index))) cs2.ready = true;
}

// --- single instance ---

const PIDFILE = path.join(HERE, 'agent.pid');
function otherInstance() {
  try {
    const pid = +fs.readFileSync(PIDFILE, 'utf8');
    if (pid && pid !== process.pid) { process.kill(pid, 0); return pid; }
  } catch { /* no file or the process is gone */ }
  return null;
}

const HELP = `
Gotowe. W grze:
  F6  stań w miejscu rzutu i wyceluj: zapis pozycji, celownika i screena
  F7  po rzucie: screen efektu
  F8  stań tam, gdzie granat wylądował: punkt na radarze
  F5  powrót na ostatnią pozycję z F6
Zakładka „Podgląd” w Granko steruje tym PC: start CS2, teleport ze screenem, zamknięcie gry.
Każdy zapis potwierdza krótki dźwięk. Wszystko ląduje w Granko (Line-upy), uzupełnij tam nazwę i rodzaj granatu.
Na koniec w konsoli: exec grankooff (przywraca HUD i broń). Ctrl+C zamyka recorder.
`;

async function main() {
  console.log(`Granko ${AGENT ? 'Agent' : 'Recorder'} · ${new Date().toLocaleString('pl-PL')} · CS2: ${GAME}`);
  try {
    const pb = await rpc('playbook', {});
    const me = pb.members.find(m => m.name.toLowerCase() === String(config.member || '').toLowerCase());
    state.memberId = me?.id || null;
    console.log(`Hasło OK${me ? `, nagrywasz jako ${me.name}` : ''}.`);
  } catch (err) {
    console.error(`Nie mogę się połączyć z Granko: ${err.message}`);
    if (AGENT) { setTimeout(main, 60e3); return; } // no network yet right after login: try again
    process.exit(1);
  }
  writeCfgs();

  const other = otherInstance();
  if (other) {
    if (AGENT) process.exit(0);
    await rpc('agent_submit', { p_kind: 'start', p_payload: { map: startMap }, p_by: state.memberId });
    console.log(`Agent Granko już działa w tle (PID ${other}), poprosiłem go o uruchomienie CS2 na ${OVERVIEWS[startMap].name}.`);
    console.log(HELP);
    process.exit(0);
  }
  fs.writeFileSync(PIDFILE, String(process.pid));
  const cleanup = () => { try { if (+fs.readFileSync(PIDFILE, 'utf8') === process.pid) fs.unlinkSync(PIDFILE); } catch { /* gone */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));

  follow();
  refreshCs2();
  primeFromLog();
  agentLoop();
  if (AGENT) {
    console.log('Agent czeka na polecenia ze strony (zakładka Podgląd).');
    return;
  }
  try {
    await ensurePractice(startMap);
    console.log(HELP);
  } catch (err) {
    console.error(err.message);
  }
}

main();
