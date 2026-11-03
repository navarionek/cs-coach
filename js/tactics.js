// Tactics: per map and side, five roles each with a player, position, task and attached lineups.
import {
  team, store, rpc, loadPlaybook, esc, toast, openModal, confirmBox, lightbox, imageUrl,
  MAPS, KINDS, ROLE_PRESETS, segmented, bindSegmented, mapSwitch, sideBadge, kindBadge, nadeBadge,
  lineup, member, memberTag, memberColor, tactic,
} from './core.js';
import { pickLineups, openLineup } from './lineups.js';
import { hasRadar, planStatic, mountPlan, mountRouteEditor } from './radar.js';
import { TAGS, tacticSite } from './brain.js';

const ui = { map: store.get('cs.map') || MAPS[0].id, side: store.get('cs.side') || 'T', archived: false };
const KIND_ORDER = ['pistol', 'eco', 'force', 'full', 'any'];

export const record = id => team.callStats[id] || { w: 0, n: 0 };
export const recordText = id => {
  const r = record(id);
  return r.n ? `${r.w}W ${r.n - r.w}L` : 'nie grana';
};

export function renderTactics(el) {
  const list = team.playbook.tactics.filter(x => x.map === ui.map && x.side === ui.side && x.archived === ui.archived);
  const groups = KIND_ORDER.map(k => [k, list.filter(x => x.kind === k)]).filter(([, xs]) => xs.length);
  el.innerHTML = `
    <div class="toolbar">
      ${mapSwitch(ui.map)}
      ${segmented('side', [['T', 'T'], ['CT', 'CT']], ui.side)}
      <button type="button" class="btn primary" data-act="new">+ Nowa taktyka</button>
    </div>
    ${groups.length ? groups.map(([k, xs]) => `
      <h3 class="group-h">${kindBadge(k)} <span class="muted small">${xs.length}</span></h3>
      <div class="tac-grid">${xs.map(tacticCard).join('')}</div>`).join('')
      : `<div class="card empty"><h3>${ui.archived ? 'Brak zarchiwizowanych taktyk' : `Brak taktyk na ${esc(MAPS.find(m => m.id === ui.map).name)} jako ${ui.side}`}</h3>
          <p class="muted">Taktyka to plan na rundę: 5 ról, każda ze swoim graczem, pozycją, zadaniem i granatami. W trybie live system sam wybiera taktykę na kolejną rundę, a każdy widzi swoje zadanie.</p></div>`}
    <p class="center"><button type="button" class="link" data-act="archived">${ui.archived ? '← wróć do aktywnych' : 'pokaż zarchiwizowane'}</button></p>`;

  bindSegmented(el, 'map', v => { ui.map = v; store.set('cs.map', v); renderTactics(el); });
  bindSegmented(el, 'side', v => { ui.side = v; store.set('cs.side', v); renderTactics(el); });
  el.querySelector('[data-act="new"]').onclick = () => editTactic(null);
  el.querySelector('[data-act="archived"]').onclick = () => { ui.archived = !ui.archived; renderTactics(el); };
  el.querySelectorAll('[data-tactic]').forEach(c => c.addEventListener('click', () => openTactic(c.dataset.tactic)));
}

function tacticCard(x) {
  const nades = x.roles.flatMap(r => r.lineups || []).map(lineup).filter(Boolean);
  const r = record(x.id);
  return `<button type="button" class="card tac-card" data-tactic="${esc(x.id)}">
    <div class="tac-top"><b>${esc(x.name)}</b><span class="rec ${r.n ? (r.w / r.n >= 0.5 ? 'good' : 'bad') : ''}">${recordText(x.id)}</span></div>
    ${x.summary ? `<p class="muted">${esc(x.summary)}</p>` : ''}
    ${tacticSite(x) || x.tags?.length ? `<div class="tac-tags">${tacticSite(x) ? `<span class="site-badge">${esc(tacticSite(x))}</span>` : ''}${(x.tags || []).map(t => `<span>${esc(TAGS[x.side]?.[t] || t)}</span>`).join('')}</div>` : ''}
    <div class="tac-roles">${x.roles.map(role => `<span class="role-pill" style="--c:${esc(memberColor(member(role.member_id)))}">${esc(role.name || '?')}${member(role.member_id) ? ` · ${esc(member(role.member_id).name)}` : ''}</span>`).join('')}</div>
    ${nades.length ? `<div class="muted small">${nades.length} granat${nades.length === 1 ? '' : nades.length < 5 ? 'y' : 'ów'}</div>` : ''}
  </button>`;
}

// Role card used both in the tactic view and in live mode.
// `plan` ({map, roles}) draws the team routes with this role highlighted (live mode).
export function roleBlock(role, { mine = false, big = false, plan = null } = {}) {
  const m = member(role.member_id);
  const lus = (role.lineups || []).map(lineup).filter(Boolean);
  return `<div class="role ${mine ? 'mine' : ''} ${big ? 'big' : ''}" style="--c:${esc(memberColor(m))}">
    <div class="role-head"><span class="role-name">${esc(role.name || 'Rola')}</span>${memberTag(m)}</div>
    ${role.position ? `<div class="role-pos">📍 ${esc(role.position)}</div>` : ''}
    ${role.task ? `<div class="role-task">${esc(role.task)}</div>` : ''}
    ${big && plan ? planStatic(plan.map, plan.roles, { highlight: plan.roles.indexOf(role), lineups: lus }) : ''}
    ${lus.length ? `<div class="role-lus">${lus.map(l => {
      const img = l.images?.[0];
      return `<button type="button" class="role-lu" data-open-lineup="${esc(l.id)}">
        ${img ? `<img src="${esc(imageUrl(img.path))}" alt="" loading="lazy">` : ''}
        <span>${nadeBadge(l.nade)} ${esc(l.title)}</span></button>`;
    }).join('')}</div>` : ''}
  </div>`;
}

// Lineup thumbnails inside a role open the full lineup.
export function bindRoleLineups(root, { gallery = false } = {}) {
  root.querySelectorAll('[data-open-lineup]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    const l = lineup(b.dataset.openLineup);
    if (gallery && l?.images?.length) lightbox(l.images, 0);
    else openLineup(b.dataset.openLineup);
  }));
}

export function openTactic(id) {
  const x = tactic(id);
  if (!x) return;
  const { el, close } = openModal(`
    <div class="tac-detail">
      <div class="lu-badges">${kindBadge(x.kind)}${sideBadge(x.side)}<span class="mapname">${esc(MAPS.find(m => m.id === x.map)?.name || x.map)}</span><span class="rec">${recordText(x.id)}</span></div>
      <h2>${esc(x.name)}</h2>
      ${x.summary ? `<p class="lead">${esc(x.summary)}</p>` : ''}
      ${x.notes ? `<p class="notes">${esc(x.notes)}</p>` : ''}
      <div class="tac-plan"></div>
      <div class="roles-grid">${x.roles.map(r => roleBlock(r, { mine: r.member_id === team.me })).join('')}</div>
      <div class="actions">
        <button type="button" class="btn ghost" data-act="archive">${x.archived ? 'Przywróć' : 'Archiwizuj'}</button>
        <button type="button" class="btn" data-act="dup">Duplikuj</button>
        <button type="button" class="btn primary" data-act="edit">Edytuj</button>
      </div>
    </div>`, { wide: true });
  bindRoleLineups(el);
  mountPlan(el.querySelector('.tac-plan'), {
    map: x.map, roles: x.roles, lineups: x.roles.flatMap(r => (r.lineups || []).map(lineup).filter(Boolean)), onOpen: openLineup,
  });
  el.querySelector('[data-act="edit"]').onclick = () => { close(); editTactic(x); };
  el.querySelector('[data-act="dup"]').onclick = () => {
    close();
    const copy = structuredClone(x);
    delete copy.id;
    copy.name = `${x.name} (kopia)`;
    editTactic(copy);
  };
  el.querySelector('[data-act="archive"]').onclick = async () => {
    if (!x.archived && !await confirmBox(`Zarchiwizować „${x.name}”? Nie będzie proponowana w live, statystyki zostają.`, 'Archiwizuj')) return;
    await rpc('save_tactic', { t: { ...x, archived: !x.archived } });
    await loadPlaybook();
    close();
  };
}

export function editTactic(existing) {
  const side = existing?.side || ui.side;
  const ms = team.playbook.members;
  const x = existing ? structuredClone(existing) : {
    map: ui.map, side, kind: 'full', roles: ROLE_PRESETS[side].map((name, i) => ({ name, member_id: ms[i]?.id || null, position: '', task: '', lineups: [] })),
  };
  while (x.roles.length < 5) x.roles.push({ name: '', member_id: null, position: '', task: '', lineups: [] });

  const { el, close } = openModal(`
    <form class="editor tac-editor">
      <h2>${existing?.id ? 'Edytuj taktykę' : 'Nowa taktyka'}</h2>
      <div class="row3">
        <label>Mapa<select name="map">${MAPS.map(m => `<option value="${m.id}" ${m.id === x.map ? 'selected' : ''}>${m.name}</option>`).join('')}</select></label>
        <label>Strona<select name="side">${['T', 'CT'].map(s => `<option ${s === x.side ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label>Na jaką ekonomię<select name="kind">${Object.entries(KINDS).map(([v, n]) => `<option value="${v}" ${v === x.kind ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <div class="row2">
        <label>Cel<select name="site">${[['', 'Auto (z tras i granatów)'], ['A', 'A'], ['B', 'B'], ['mid', 'Mid']].map(([v, n]) => `<option value="${v}" ${v === (x.site || '') ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <div><div class="label muted small">Styl (pomaga mózgowi dobrać taktykę)</div><div class="tag-pick"></div></div>
      </div>
      <label>Nazwa<input name="name" value="${esc(x.name || '')}" placeholder="np. B split przez banana i CT" maxlength="60" required></label>
      <label>Call w jednym zdaniu<input name="summary" value="${esc(x.summary || '')}" placeholder="np. Szybko B, smoke CT + molotov dark, flash nad bananem" maxlength="140"></label>
      <label>Notatki (timing, plan B, na co uważać)<textarea name="notes" rows="2">${esc(x.notes || '')}</textarea></label>
      <datalist id="role-names">${[...ROLE_PRESETS.T, ...ROLE_PRESETS.CT].map(n => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="roles-edit"></div>
      <div class="actions">
        <button type="button" class="btn" data-act="cancel">Anuluj</button>
        <button class="btn primary">Zapisz</button>
      </div>
    </form>`, { wide: true, dismissable: false });
  const form = el.querySelector('form');
  const rolesEl = el.querySelector('.roles-edit');
  const tagsEl = el.querySelector('.tag-pick');
  let tags = new Set(x.tags || []);
  // Tags depend on the side; switching side keeps only the ones both sides share.
  const drawTags = () => {
    const opts = TAGS[form.side.value];
    tags = new Set([...tags].filter(t => opts[t]));
    tagsEl.innerHTML = Object.entries(opts).map(([v, n]) => `<label class="tag-opt"><input type="checkbox" value="${v}" ${tags.has(v) ? 'checked' : ''}><span>${n}</span></label>`).join('');
    tagsEl.querySelectorAll('input').forEach(i => i.addEventListener('change', () => { i.checked ? tags.add(i.value) : tags.delete(i.value); }));
  };
  drawTags();
  form.side.addEventListener('change', drawTags);

  // Keep typed text when redrawing after lineup changes.
  function syncRoles() {
    rolesEl.querySelectorAll('.role-edit').forEach((card, i) => {
      const r = x.roles[i];
      r.name = card.querySelector('[name="rname"]').value.trim();
      r.member_id = card.querySelector('[name="rmember"]').value || null;
      r.position = card.querySelector('[name="rpos"]').value.trim();
      r.task = card.querySelector('[name="rtask"]').value.trim();
    });
  }

  function drawRoles() {
    rolesEl.innerHTML = x.roles.map((r, i) => {
      const lus = (r.lineups || []).map(lineup).filter(Boolean);
      return `<div class="role-edit" style="--c:${esc(memberColor(member(r.member_id)))}">
        <div class="row2">
          <label>Rola ${i + 1}<input name="rname" list="role-names" value="${esc(r.name || '')}" placeholder="np. Entry" maxlength="30"></label>
          <label>Gracz<select name="rmember"><option value="">— ktokolwiek —</option>${ms.map(m => `<option value="${esc(m.id)}" ${m.id === r.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        </div>
        <label>Pozycja<input name="rpos" value="${esc(r.position || '')}" placeholder="np. banana, za skrzynią" maxlength="80"></label>
        <label>Zadanie<textarea name="rtask" rows="3" placeholder="np. 1:40 flash nad car, wchodzisz pierwszy na site, czyścisz plat">${esc(r.task || '')}</textarea></label>
        <div class="route-row">
          ${r.path?.length ? planStatic(form.map.value, [r], { cls: 'mini' }) : ''}
          <button type="button" class="btn small" data-route="${i}" ${hasRadar(form.map.value) ? '' : 'disabled'}>🗺 ${r.path?.length ? `Trasa (${r.path.length} pkt)` : 'Wyznacz trasę'}</button>
        </div>
        <div class="role-lus edit">
          ${lus.map(l => `<span class="lu-chip">${nadeBadge(l.nade)} ${esc(l.title)}<button type="button" data-rm-lu="${esc(l.id)}" data-role="${i}">✕</button></span>`).join('')}
          <button type="button" class="btn small" data-add-lu="${i}">+ granaty</button>
        </div>
      </div>`;
    }).join('');
    rolesEl.querySelectorAll('[name="rmember"]').forEach(s => s.addEventListener('change', () => {
      s.closest('.role-edit').style.setProperty('--c', memberColor(member(s.value)));
    }));
    rolesEl.querySelectorAll('[data-rm-lu]').forEach(b => b.onclick = () => {
      syncRoles();
      const r = x.roles[+b.dataset.role];
      r.lineups = r.lineups.filter(id => id !== b.dataset.rmLu);
      drawRoles();
    });
    rolesEl.querySelectorAll('[data-route]').forEach(b => b.onclick = async () => {
      syncRoles();
      const path = await editRoute(form.map.value, x.roles, +b.dataset.route);
      if (path) x.roles[+b.dataset.route].path = path;
      drawRoles();
    });
    rolesEl.querySelectorAll('[data-add-lu]').forEach(b => b.onclick = async () => {
      syncRoles();
      const r = x.roles[+b.dataset.addLu];
      const ids = await pickLineups({ map: form.map.value, side: form.side.value, selected: r.lineups || [] });
      if (ids) r.lineups = ids;
      drawRoles();
    });
  }
  drawRoles();
  form.map.addEventListener('change', drawRoles);

  el.querySelector('[data-act="cancel"]').onclick = () => close();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    syncRoles();
    const payload = {
      ...x,
      map: form.map.value,
      side: form.side.value,
      kind: form.kind.value,
      site: form.site.value || null,
      tags: [...tags],
      name: form.name.value.trim(),
      summary: form.summary.value.trim(),
      notes: form.notes.value.trim(),
      roles: x.roles.filter(r => r.name || r.member_id || r.position || r.task || r.lineups?.length),
      created_by: x.created_by || team.me,
    };
    try {
      const id = await rpc('save_tactic', { t: payload });
      await loadPlaybook();
      toast('Zapisano taktykę');
      close();
      openTactic(id);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  form.name.focus();
}

// Route editor for one role over the team plan. Resolves with the new path, or null when cancelled.
function editRoute(map, roles, index) {
  return new Promise(resolve => {
    const role = roles[index];
    let path = role.path || [];
    let done = false;
    const lus = (role.lineups || []).map(lineup).filter(Boolean);
    const who = member(role.member_id);
    const { el, close } = openModal(`
      <div class="route-editor">
        <h2>Trasa: ${esc(role.name || `Rola ${index + 1}`)}${who ? ` <span class="mtag" style="--c:${esc(memberColor(who))}">${esc(who.name)}</span>` : ''}</h2>
        <p class="muted small">Pierwszy punkt to start, kolejne to miejsca po drodze, ostatni to cel. Inne role są przygaszone, żeby było widać, jak się zgrywacie.</p>
        <div class="route-ed"></div>
        <div class="actions">
          <button type="button" class="btn" data-act="cancel">Anuluj</button>
          <button type="button" class="btn primary" data-act="ok">Gotowe</button>
        </div>
      </div>`, { wide: true, dismissable: false, onClose: () => resolve(done ? path : null) });
    mountRouteEditor(el.querySelector('.route-ed'), { map, roles, index, lineups: lus, onChange: p => { path = p; } });
    el.querySelector('[data-act="cancel"]').onclick = () => close();
    el.querySelector('[data-act="ok"]').onclick = () => { done = true; close(); };
  });
}
