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
const startMap = process.argv[2] || 'de_ancient';
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
      } else if ((m = line.match(/execing (grankopos|grankoshot|grankoland)\b/))) {
        pending = m[1];
      } else if (pending && (m = line.match(/setpos\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+);\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)/))) {
        const p = { x: +(+m[1]).toFixed(2), y: +(+m[2]).toFixed(2), z: +(+m[3]).toFixed(2), pitch: +(+m[4]).toFixed(2), yaw: +(+m[5]).toFixed(2) };
        if (pending === 'grankopos') onPos(p);
        else if (pending === 'grankoshot') onShot();
        else onLand(p);
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
    if (size <= start) continue;
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    if (re.test(buf.toString('utf8'))) return true;
  }
  return false;
}

async function main() {
  console.log(`Granko Recorder · CS2: ${GAME}`);
  try {
    const pb = await rpc('playbook', {});
    const me = pb.members.find(m => m.name.toLowerCase() === String(config.member || '').toLowerCase());
    state.memberId = me?.id || null;
    console.log(`Hasło OK${me ? `, nagrywasz jako ${me.name}` : ''}.`);
  } catch (err) {
    console.error(`Nie mogę się połączyć z Granko: ${err.message}`);
    process.exit(1);
  }
  writeCfgs();

  const cmd = cs2CommandLine();
  if (cmd && !cmd.includes('-condebug')) {
    console.error('CS2 jest włączony bez -condebug, więc nie widzę konsoli. Zamknij grę i uruchom recorder jeszcze raz.');
    process.exit(1);
  }
  if (!cmd) {
    console.log(`Uruchamiam CS2 offline na ${OVERVIEWS[startMap].name}…`);
    const steam = path.join(steamPath(), 'steam.exe');
    spawn(steam, ['-applaunch', '730', '-condebug', '-novid', '+map', startMap], { detached: true, stdio: 'ignore' }).unref();
    if (!await waitFor(/Host activate: Loading/, 180e3)) {
      console.error('Gra nie załadowała mapy w 3 minuty.');
      process.exit(1);
    }
    await sleep(8000); // let the player spawn before the cheats/bot commands
  }
  follow();
  // The console key can land while a menu is open; check the log and try again.
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    console.log(i ? '  …nie zadziałało, ponawiam' : 'Wpisuję w konsoli: exec granko');
    const from = logSize();
    typeExec('granko');
    ok = await waitFor(/execing granko\r?\n/, 5000, from);
  }
  if (!ok) console.log('Nie udało się wpisać komendy. Otwórz konsolę (~) i wpisz sam: exec granko');
  console.log(`
Gotowe. W grze:
  F6  stań w miejscu rzutu i wyceluj: zapis pozycji, celownika i screena
  F7  po rzucie: screen efektu
  F8  stań tam, gdzie granat wylądował: punkt na radarze
  F5  powrót na ostatnią pozycję z F6
Każdy zapis potwierdza krótki dźwięk. Wszystko ląduje w Granko (Line-upy), uzupełnij tam nazwę i rodzaj granatu.
Na koniec w konsoli: exec grankooff (przywraca HUD i broń). Ctrl+C zamyka recorder.
`);
}

main();
