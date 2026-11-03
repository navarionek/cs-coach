// Grenade lineup library: grid with filters, detail view, editor with pasted/dropped screenshots,
// and a picker the tactic editor uses to attach lineups to roles.
import {
  team, store, rpc, loadPlaybook, esc, toast, openModal, confirmBox, lightbox, uploadImage, deleteImages, imageUrl,
  MAPS, NADES, THROWS, CAPTIONS, segmented, bindSegmented, mapSwitch, sideBadge, nadeBadge, lineup, member, memberTag,
} from './core.js';

const ui = { map: store.get('cs.map') || MAPS[0].id, side: 'all', nade: 'all', q: '' };

const cover = l => l.images?.find(i => i.caption === 'result') || l.images?.[0];

function filtered({ map, side, nade, q }) {
  const needle = (q || '').trim().toLowerCase();
  return team.playbook.lineups.filter(l =>
    l.map === map
    && (side === 'all' || l.side === side || l.side === 'any')
    && (nade === 'all' || l.nade === nade)
    && (!needle || [l.title, l.target, l.position, l.description].some(x => (x || '').toLowerCase().includes(needle))));
}

export function lineupCard(l, { selectable = false, selected = false } = {}) {
  const img = cover(l);
  return `<button type="button" class="lu-card ${selected ? 'selected' : ''}" data-lineup="${esc(l.id)}">
    <div class="lu-img" ${img ? `style="background-image:url('${esc(imageUrl(img.path))}')"` : ''}>
      ${img ? '' : `<span class="lu-noimg">${NADES[l.nade]?.icon || '?'}</span>`}
      <div class="lu-badges">${nadeBadge(l.nade)}${sideBadge(l.side)}</div>
      ${l.images?.length > 1 ? `<span class="lu-count">📷 ${l.images.length}</span>` : ''}
      ${selectable ? `<span class="lu-check">${selected ? '✓' : '+'}</span>` : ''}
    </div>
    <div class="lu-body">
      <b>${esc(l.title)}</b>
      <span class="muted small">${l.position ? esc(l.position) : ''}${l.position && l.target ? ' → ' : ''}${l.target ? esc(l.target) : ''}</span>
      ${l.throw ? `<span class="throw">${esc(THROWS[l.throw] || l.throw)}</span>` : ''}
    </div>
  </button>`;
}

export function renderLineups(el) {
  el.innerHTML = `
    <div class="toolbar">
      ${mapSwitch(ui.map)}
      <button type="button" class="btn primary" data-act="new">+ Nowy line-up</button>
    </div>
    <div class="toolbar sub">
      ${segmented('side', [['all', 'Obie strony'], ['T', 'T'], ['CT', 'CT']], ui.side)}
      ${segmented('nade', [['all', 'Wszystkie'], ...Object.entries(NADES).map(([k, n]) => [k, `${n.icon} ${n.label}`])], ui.nade)}
      <input class="search" type="search" placeholder="Szukaj: A site, CT smoke…" value="${esc(ui.q)}">
    </div>
    <div class="lu-grid"></div>`;
  const grid = el.querySelector('.lu-grid');
  const drawGrid = () => {
    const list = filtered(ui);
    grid.innerHTML = list.length
      ? list.map(l => lineupCard(l)).join('')
      : `<div class="card empty wide-empty"><h3>Brak line-upów na ${esc(MAPS.find(m => m.id === ui.map)?.name)}</h3>
          <p class="muted">Zrób screena w grze (Win+Shift+S albo F12 na Steamie), kliknij <b>+ Nowy line-up</b> i wklej go Ctrl+V.</p></div>`;
    grid.querySelectorAll('[data-lineup]').forEach(b => b.addEventListener('click', () => openLineup(b.dataset.lineup)));
  };
  drawGrid();
  bindSegmented(el, 'map', v => { ui.map = v; store.set('cs.map', v); renderLineups(el); });
  bindSegmented(el, 'side', v => { ui.side = v; renderLineups(el); });
  bindSegmented(el, 'nade', v => { ui.nade = v; renderLineups(el); });
  el.querySelector('.search').addEventListener('input', e => { ui.q = e.target.value; drawGrid(); });
  el.querySelector('[data-act="new"]').addEventListener('click', () => editLineup(null, { map: ui.map, side: ui.side === 'all' ? 'T' : ui.side, nade: ui.nade === 'all' ? 'smoke' : ui.nade }));
}

export function openLineup(id) {
  const l = lineup(id);
  if (!l) return;
  const imgs = l.images || [];
  const { el, close } = openModal(`
    <div class="lu-detail">
      <div class="lu-head">
        <div class="lu-badges">${nadeBadge(l.nade)}${sideBadge(l.side)}<span class="mapname">${esc(MAPS.find(m => m.id === l.map)?.name || l.map)}</span></div>
        <h2>${esc(l.title)}</h2>
        <div class="lu-route">
          ${l.position ? `<div><span class="muted small">SKĄD</span><b>${esc(l.position)}</b></div>` : ''}
          ${l.target ? `<div><span class="muted small">GDZIE LĄDUJE</span><b>${esc(l.target)}</b></div>` : ''}
          ${l.throw ? `<div><span class="muted small">RZUT</span><b>${esc(THROWS[l.throw] || l.throw)}</b></div>` : ''}
        </div>
      </div>
      ${imgs.length ? `<div class="lu-gallery">${imgs.map((img, i) => `
        <figure data-i="${i}"><img src="${esc(imageUrl(img.path))}" alt="" loading="lazy"><figcaption>${esc(CAPTIONS[img.caption] || '')}</figcaption></figure>`).join('')}
      </div>` : '<p class="muted">Brak screenów.</p>'}
      ${l.description ? `<p class="lu-desc">${esc(l.description)}</p>` : ''}
      ${l.video_url ? `<p><a href="${esc(l.video_url)}" target="_blank" rel="noopener">▶ Film z rzutem</a></p>` : ''}
      <div class="actions">
        <span class="muted small">${l.created_by ? `dodał(a) ${memberTag(member(l.created_by))}` : ''}</span>
        <button type="button" class="btn ghost" data-act="del">Usuń</button>
        <button type="button" class="btn primary" data-act="edit">Edytuj</button>
      </div>
    </div>`, { wide: true });
  el.querySelectorAll('.lu-gallery figure').forEach(f => f.addEventListener('click', () => lightbox(imgs, +f.dataset.i)));
  el.querySelector('[data-act="edit"]').onclick = () => { close(); editLineup(l); };
  el.querySelector('[data-act="del"]').onclick = async () => {
    if (!await confirmBox(`Usunąć line-up „${l.title}”?`)) return;
    const removed = await rpc('delete_lineup', { lineup_id: l.id });
    deleteImages(removed.map(i => i.path));
    await loadPlaybook();
    close();
    toast('Usunięto line-up');
  };
}

// Resolves with the saved lineup id, or null when cancelled.
export function editLineup(existing, defaults = {}) {
  return new Promise(resolve => {
    const l = existing ? structuredClone(existing) : { map: ui.map, side: 'T', nade: 'smoke', throw: 'left', images: [], ...defaults };
    const original = new Set((existing?.images || []).map(i => i.path));
    const uploaded = new Set(); // uploaded in this session, deleted again if the editor is cancelled
    let images = [...(l.images || [])];
    let pending = 0;
    let saved = false;

    const { el, close } = openModal(`
      <form class="editor lu-editor">
        <h2>${existing ? 'Edytuj line-up' : 'Nowy line-up'}</h2>
        <div class="row3">
          <label>Mapa<select name="map">${MAPS.map(m => `<option value="${m.id}" ${m.id === l.map ? 'selected' : ''}>${m.name}</option>`).join('')}</select></label>
          <label>Strona<select name="side">${[['T', 'T'], ['CT', 'CT'], ['any', 'Obie']].map(([v, n]) => `<option value="${v}" ${v === l.side ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>Rodzaj rzutu<select name="throw">${Object.entries(THROWS).map(([v, n]) => `<option value="${v}" ${v === l.throw ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
        <div class="nade-pick">${Object.entries(NADES).map(([k, n]) => `
          <label class="nade-opt nade-${k}"><input type="radio" name="nade" value="${k}" ${k === l.nade ? 'checked' : ''}><span>${n.icon} ${n.label}</span></label>`).join('')}
        </div>
        <label>Nazwa<input name="title" value="${esc(l.title || '')}" placeholder="np. Smoke CT z T spawnu" maxlength="80" required></label>
        <div class="row2">
          <label>Skąd rzucasz<input name="position" value="${esc(l.position || '')}" placeholder="np. T spawn, róg skrzyni" maxlength="80"></label>
          <label>Gdzie ląduje<input name="target" value="${esc(l.target || '')}" placeholder="np. CT na A" maxlength="80"></label>
        </div>
        <div class="images-field">
          <div class="label">Screeny <span class="muted small">gdzie stanąć, gdzie celować, efekt</span></div>
          <div class="img-list"></div>
          <label class="dropzone" tabindex="0">
            <input type="file" accept="image/*" multiple hidden>
            <b>Wklej screena (Ctrl+V)</b>, przeciągnij albo kliknij, żeby wybrać
          </label>
        </div>
        <label>Opis / jak celować<textarea name="description" rows="3" placeholder="np. Celownik na antenę, krok w prawo, jump throw">${esc(l.description || '')}</textarea></label>
        <label>Link do filmiku (opcjonalnie)<input name="video_url" type="url" value="${esc(l.video_url || '')}" placeholder="https://youtu.be/…"></label>
        <div class="actions">
          <button type="button" class="btn" data-act="cancel">Anuluj</button>
          <button class="btn primary" data-act="save">Zapisz</button>
        </div>
      </form>`, { wide: true, dismissable: false, onClose: () => {
        document.removeEventListener('paste', onPaste);
        if (!saved) deleteImages([...uploaded]);
        resolve(saved || null);
      } });

    const form = el.querySelector('form');
    const list = el.querySelector('.img-list');
    const drop = el.querySelector('.dropzone');
    const fileInput = drop.querySelector('input');

    function drawImages() {
      list.innerHTML = images.map((img, i) => `
        <div class="img-tile">
          <img src="${esc(imageUrl(img.path))}" alt="">
          <select data-i="${i}">${Object.entries(CAPTIONS).map(([v, n]) => `<option value="${v}" ${v === img.caption ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <div class="tile-btns">
            <button type="button" data-mv="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''}>‹</button>
            <button type="button" data-rm="${i}">✕</button>
            <button type="button" data-mv="1" data-i="${i}" ${i === images.length - 1 ? 'disabled' : ''}>›</button>
          </div>
        </div>`).join('') + Array.from({ length: pending }, () => '<div class="img-tile loading"><span class="spinner"></span></div>').join('');
      list.querySelectorAll('select').forEach(s => s.onchange = () => { images[+s.dataset.i].caption = s.value; });
      list.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { images.splice(+b.dataset.rm, 1); drawImages(); });
      list.querySelectorAll('[data-mv]').forEach(b => b.onclick = () => {
        const i = +b.dataset.i, j = i + +b.dataset.mv;
        [images[i], images[j]] = [images[j], images[i]];
        drawImages();
      });
    }

    async function addFiles(files) {
      const imgs = [...files].filter(f => f.type.startsWith('image/'));
      if (!imgs.length) return;
      pending += imgs.length;
      drawImages();
      await Promise.all(imgs.map(async f => {
        try {
          const path = await uploadImage(f);
          uploaded.add(path);
          const order = ['pos', 'aim', 'result'];
          images.push({ path, caption: order[images.length] || 'other' });
        } catch (err) {
          toast(`Nie udało się wrzucić screena: ${err.message}`, 'err');
        } finally {
          pending--;
          drawImages();
        }
      }));
    }

    function onPaste(e) {
      const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); addFiles(files); }
    }
    document.addEventListener('paste', onPaste);
    fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    drawImages();

    el.querySelector('[data-act="cancel"]').onclick = () => close();
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (pending) { toast('Poczekaj, aż screeny się wgrają', 'err'); return; }
      const btn = form.querySelector('[data-act="save"]');
      btn.disabled = true;
      const payload = {
        id: existing?.id,
        map: form.map.value,
        side: form.side.value,
        nade: form.nade.value,
        throw: form.throw.value,
        title: form.title.value.trim(),
        position: form.position.value.trim(),
        target: form.target.value.trim(),
        description: form.description.value.trim(),
        video_url: form.video_url.value.trim(),
        images,
        created_by: existing?.created_by || team.me,
      };
      try {
        const id = await rpc('save_lineup', { l: payload });
        const kept = new Set(images.map(i => i.path));
        deleteImages([...original, ...uploaded].filter(p => !kept.has(p)));
        uploaded.clear();
        saved = id;
        await loadPlaybook();
        toast('Zapisano line-up');
        close();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });
    form.title.focus();
  });
}

// Lineup picker for the tactic editor. Resolves with the chosen ids, or null when cancelled.
export function pickLineups({ map, side, selected = [] }) {
  return new Promise(resolve => {
    const chosen = new Set(selected);
    const f = { map, side, nade: 'all', q: '' };
    let done = false;
    const { el, close } = openModal(`
      <div class="picker">
        <h2>Line-upy do roli</h2>
        <div class="toolbar sub">
          ${segmented('nade', [['all', 'Wszystkie'], ...Object.entries(NADES).map(([k, n]) => [k, `${n.icon} ${n.label}`])], f.nade)}
          <input class="search" type="search" placeholder="Szukaj…">
        </div>
        <div class="lu-grid compact"></div>
        <div class="actions">
          <button type="button" class="btn" data-act="new">+ Nowy line-up</button>
          <button type="button" class="btn primary" data-act="done">Gotowe</button>
        </div>
      </div>`, { wide: true, onClose: () => resolve(done ? [...chosen] : null) });
    const grid = el.querySelector('.lu-grid');
    const draw = () => {
      const list = filtered(f);
      grid.innerHTML = list.length ? list.map(l => lineupCard(l, { selectable: true, selected: chosen.has(l.id) })).join('')
        : '<p class="muted pad">Brak line-upów dla tej mapy i strony. Dodaj pierwszy.</p>';
      grid.querySelectorAll('[data-lineup]').forEach(b => b.addEventListener('click', () => {
        const id = b.dataset.lineup;
        chosen.has(id) ? chosen.delete(id) : chosen.add(id);
        draw();
      }));
    };
    el.querySelectorAll('[data-seg="nade"] button').forEach(b => b.addEventListener('click', () => {
      f.nade = b.dataset.v;
      el.querySelectorAll('[data-seg="nade"] button').forEach(x => x.classList.toggle('on', x === b));
      draw();
    }));
    el.querySelector('.search').addEventListener('input', e => { f.q = e.target.value; draw(); });
    el.querySelector('[data-act="new"]').onclick = async () => {
      const id = await editLineup(null, { map, side });
      if (id) chosen.add(id);
      draw();
    };
    el.querySelector('[data-act="done"]').onclick = () => { done = true; close(); };
    draw();
  });
}
