// Shared client, constants, team session and small UI helpers.
export const SUPABASE_URL = 'https://qnhzbnofloghyhbmkvnq.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_wDsMbOBSA67oTBVOcan80g_mLhKrnqW';
export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { db: { schema: 'cs' } });

export const MAPS = [
  { id: 'de_ancient', name: 'Ancient' },
  { id: 'de_inferno', name: 'Inferno' },
  { id: 'de_nuke', name: 'Nuke' },
];
export const NADES = {
  smoke: { label: 'Smoke', icon: '☁' },
  flash: { label: 'Flash', icon: '✦' },
  molotov: { label: 'Molotov', icon: '🔥' },
  he: { label: 'HE', icon: '💥' },
  decoy: { label: 'Decoy', icon: '◌' },
};
export const THROWS = {
  left: 'Lewy klik',
  right: 'Prawy klik',
  both: 'Lewy + prawy',
  jump: 'Jump throw',
  run_jump: 'Bieg + jump throw',
  walk_jump: 'Chód + jump throw',
  crouch: 'Kucnij i rzuć',
};
export const KINDS = { pistol: 'Pistolet', eco: 'Eco', force: 'Force buy', full: 'Full buy', any: 'Dowolna' };
export const CAPTIONS = { pos: 'Gdzie stanąć', aim: 'Gdzie celować', result: 'Efekt', other: 'Inne' };
export const ROLE_PRESETS = {
  T: ['Entry', 'Second', 'Support', 'Lurk', 'AWP'],
  CT: ['Anchor A', 'Anchor B', 'Rotator', 'AWP', 'Support'],
};
export const MEMBER_COLORS = ['#ff8a3d', '#5ab4ff', '#3ddc97', '#c77dff', '#ffd166', '#ff5d73', '#4dd4e6'];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const t = iso => iso ? new Date(iso).getTime() : null;
export const mapName = m => MAPS.find(x => x.id === m)?.name || (n => n.charAt(0).toUpperCase() + n.slice(1))(String(m || '').replace(/^(de|cs|ar)_/, ''));
export const imageUrl = path => `${SUPABASE_URL}/storage/v1/object/public/cs-lineups/${path}`;
export const money = n => n == null ? '–' : '$' + Number(n).toLocaleString('en-US');

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Team session: the key unlocks the playbook, `me` is which member this device belongs to.
export const team = { key: store.get('cs.teamKey'), me: store.get('cs.me'), playbook: null, callStats: {}, callHistory: [] };

const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, e => fn(e.detail));

export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, { k: team.key, ...args });
  if (error) throw new Error(error.message);
  return data;
}

export async function loadPlaybook() {
  team.playbook = await rpc('playbook');
  emit('playbook');
  return team.playbook;
}

// Win/loss per tactic from every called round that has a result.
export async function loadCallStats() {
  const { data, error } = await sb.from('calls').select('tactic_id,won,created_at,econ,enemy_econ').not('won', 'is', null).limit(5000);
  if (error) return;
  // Raw rows feed the brain (decay, per enemy economy); stats are the simple totals.
  team.callHistory = data;
  const stats = {};
  for (const c of data) {
    const s = (stats[c.tactic_id] ||= { w: 0, n: 0 });
    s.n++;
    if (c.won) s.w++;
  }
  team.callStats = stats;
  emit('callstats');
}

export const member = id => team.playbook?.members.find(m => m.id === id);
export const lineup = id => team.playbook?.lineups.find(l => l.id === id);
export const tactic = id => team.playbook?.tactics.find(x => x.id === id);
export const me = () => member(team.me);
export const memberColor = m => m?.color || '#8a93a6';

// --- images ---

export async function compressImage(file, max = 1920) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  let blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.85));
  // Safari can't encode webp and silently hands back a PNG.
  if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  return blob;
}

export async function uploadImage(file) {
  const blob = await compressImage(file);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/cs-upload`, {
    method: 'POST',
    headers: { 'x-team-key': team.key, 'content-type': blob.type },
    body: blob,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out.path;
}

export async function deleteImages(paths) {
  if (!paths?.length) return;
  await fetch(`${SUPABASE_URL}/functions/v1/cs-upload`, {
    method: 'DELETE',
    headers: { 'x-team-key': team.key, 'content-type': 'application/json' },
    body: JSON.stringify({ paths }),
  }).catch(() => {});
}

// --- UI helpers ---

export function segmented(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) =>
    `<button type="button" data-v="${esc(v)}" class="${v === value ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}
export function bindSegmented(root, name, fn) {
  root.querySelectorAll(`[data-seg="${name}"] button`).forEach(b => b.addEventListener('click', () => fn(b.dataset.v)));
}
// Map art (emblem + cover screenshot from the game files) comes with the playbook.
export const mapArt = (map, kind) => team.playbook?.map_art?.find(a => a.map === map && a.kind === kind);
const coverStyle = map => { const c = mapArt(map, 'cover'); return c ? `style="--cover:url('${esc(imageUrl(c.path))}')"` : ''; };
const emblem = map => { const i = mapArt(map, 'icon'); return i ? `<img class="emblem" src="${esc(imageUrl(i.path))}" alt="">` : ''; };

// Map picker tiles; same data-seg contract as segmented(), so bindSegmented works on it.
export const mapSwitch = current => `<div class="map-pick" data-seg="map">${MAPS.map(m =>
  `<button type="button" data-v="${m.id}" class="map-${m.id} ${m.id === current ? 'on' : ''}" ${coverStyle(m.id)}>${emblem(m.id)}<span>${m.name}</span></button>`).join('')}</div>`;
// Map name plate with cover and emblem (falls back to the gradient for maps without art).
export const mapPlate = (map, cls = '') => `<div class="map-plate map-${esc(map)} ${cls}" ${coverStyle(map)}>${emblem(map)}<span>${esc(mapName(map))}</span></div>`;
export const sideBadge = side => `<span class="side side-${esc(side)}">${side === 'any' ? 'T/CT' : esc(side)}</span>`;
export const nadeBadge = nade => `<span class="nade nade-${esc(nade)}">${NADES[nade]?.icon || ''} ${esc(NADES[nade]?.label || nade)}</span>`;
export const kindBadge = kind => `<span class="kind kind-${esc(kind)}">${esc(KINDS[kind] || kind)}</span>`;
export const memberTag = m => m
  ? `<span class="mtag" style="--c:${esc(memberColor(m))}">${esc(m.name)}</span>`
  : `<span class="mtag empty">nieprzypisany</span>`;

// Modal sheet. `dismissable: false` keeps editors from closing on a stray backdrop click.
export function openModal(html, { wide = false, dismissable = true, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <button type="button" class="modal-x" aria-label="Zamknij">✕</button>${html}</div>`;
  const onKey = e => {
    if (e.key === 'Escape' && dismissable && wrap === [...document.querySelectorAll('.modal-wrap')].pop()) close();
  };
  function close() {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    document.body.classList.toggle('no-scroll', !!document.querySelector('.modal-wrap, .lightbox'));
    onClose?.();
  }
  if (dismissable) wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  return { el: wrap.querySelector('.modal'), close };
}

export function confirmBox(text, okLabel = 'Usuń') {
  return new Promise(resolve => {
    const { el, close } = openModal(`<h3>${esc(text)}</h3><div class="actions">
      <button type="button" class="btn" data-a="no">Anuluj</button><button type="button" class="btn danger" data-a="yes">${esc(okLabel)}</button></div>`,
    { onClose: () => resolve(false) });
    el.querySelector('[data-a="no"]').onclick = () => close();
    el.querySelector('[data-a="yes"]').onclick = () => { resolve(true); close(); };
  });
}

export function lightbox(images, start = 0) {
  if (!images?.length) return;
  let i = start;
  const box = document.createElement('div');
  box.className = 'lightbox';
  const draw = () => {
    const img = images[i];
    box.innerHTML = `<img src="${esc(imageUrl(img.path))}" alt="">
      <div class="lb-cap">${esc(CAPTIONS[img.caption] || '')}${images.length > 1 ? ` · ${i + 1}/${images.length}` : ''}</div>
      ${images.length > 1 ? '<button class="lb-prev" aria-label="Poprzedni">‹</button><button class="lb-next" aria-label="Następny">›</button>' : ''}
      <button class="lb-x" aria-label="Zamknij">✕</button>`;
    box.querySelector('.lb-prev')?.addEventListener('click', e => { e.stopPropagation(); i = (i + images.length - 1) % images.length; draw(); });
    box.querySelector('.lb-next')?.addEventListener('click', e => { e.stopPropagation(); i = (i + 1) % images.length; draw(); });
  };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); document.body.classList.toggle('no-scroll', !!document.querySelector('.modal-wrap')); };
  const onKey = e => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft' && images.length > 1) { i = (i + images.length - 1) % images.length; draw(); }
    if (e.key === 'ArrowRight' && images.length > 1) { i = (i + 1) % images.length; draw(); }
  };
  box.addEventListener('click', e => { if (e.target === box || e.target.closest('.lb-x')) close(); });
  document.addEventListener('keydown', onKey);
  draw();
  document.body.appendChild(box);
  document.body.classList.add('no-scroll');
}

export function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}
