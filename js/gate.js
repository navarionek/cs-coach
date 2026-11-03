// Team key gate, "who are you" picker and the Drużyna tab (members + install guide).
import {
  sb, team, store, rpc, loadPlaybook, esc, toast, emit, member, me, memberColor, confirmBox, MEMBER_COLORS,
} from './core.js';

export const unlocked = () => !!team.playbook;
export const needsGate = () => !team.playbook || !me();

// Silent unlock with the key remembered on this device.
export async function boot() {
  if (!team.key) return false;
  try {
    await loadPlaybook();
    return true;
  } catch {
    return false;
  }
}

export function setMe(id) {
  team.me = id;
  store.set('cs.me', id);
  emit('me');
}

export function renderGate(el, done) {
  if (!team.playbook) {
    el.innerHTML = `<div class="card gate">
      <div class="gate-ico">🔒</div>
      <h2>Strefa drużyny</h2>
      <p class="muted">Taktyki, line-upy i tryb live widzi tylko nasza piątka. Wpisz hasło drużyny, zapamiętam je na tym urządzeniu.</p>
      <form class="gate-form">
        <input name="key" type="password" autocomplete="current-password" placeholder="Hasło drużyny" required>
        <button class="btn primary">Wejdź</button>
      </form>
      <p class="error" hidden></p>
    </div>`;
    const form = el.querySelector('form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      team.key = form.key.value.trim();
      try {
        await loadPlaybook();
        store.set('cs.teamKey', team.key);
        renderGate(el, done);
      } catch {
        team.key = null;
        const err = el.querySelector('.error');
        err.textContent = 'Złe hasło. Zapytaj ziomka, który je ma.';
        err.hidden = false;
        btn.disabled = false;
      }
    });
    form.key.focus();
    return;
  }

  if (!me()) {
    const ms = team.playbook.members;
    el.innerHTML = `<div class="card gate">
      <div class="gate-ico">🎯</div>
      <h2>Kim jesteś?</h2>
      <p class="muted">W trybie live pokażę ci twoje zadanie na każdą rundę.</p>
      ${ms.length ? `<div class="who">${ms.map(m => `<button type="button" class="who-btn" data-id="${esc(m.id)}" style="--c:${esc(memberColor(m))}">${esc(m.name)}</button>`).join('')}</div>` : ''}
      <form class="gate-form">
        <input name="name" placeholder="${ms.length ? 'Nie ma cię na liście? Wpisz nick' : 'Twój nick'}" maxlength="24" required>
        <button class="btn">Dodaj mnie</button>
      </form>
    </div>`;
    el.querySelectorAll('.who-btn').forEach(b => b.addEventListener('click', () => { setMe(b.dataset.id); done(); }));
    el.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      if (!name) return;
      try {
        const id = await rpc('save_member', { m: { name, color: MEMBER_COLORS[ms.length % MEMBER_COLORS.length] } });
        await loadPlaybook();
        setMe(id);
        done();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    return;
  }
  done();
}

const INSTALL = `<div class="card setup">
  <h2>Jak podpiąć swoją grę</h2>
  <ol>
    <li>Weź od ziomka plik <code>gamestate_integration_cscoach.cfg</code> (jest w nim token drużyny, nie wrzucaj go nigdzie publicznie).</li>
    <li>Wrzuć go do folderu<br><code>Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\</code><br>
      Najszybciej: Steam → CS2 → prawy klik → Zarządzaj → Przeglądaj pliki lokalne → <code>game\\csgo\\cfg</code>.</li>
    <li>Uruchom CS2 ponownie (gra czyta ten plik tylko przy starcie).</li>
    <li>Tu w zakładce Drużyna połącz swój nick z kontem Steam (pojawi się na liście po pierwszym meczu z plikiem).</li>
  </ol>
  <p class="muted">To oficjalne Game State Integration od Valve: gra sama wysyła stan meczu. Nic nie czyta pamięci gry, więc VAC i Faceit AC nie mają się do czego przyczepić. Każdy wysyła tylko swoje dane: kasę, kille, dmg, wynik i czas rund.</p>
</div>`;

export async function renderTeam(el) {
  if (needsGate()) {
    el.innerHTML = '<div class="gate-slot"></div>' + INSTALL;
    renderGate(el.querySelector('.gate-slot'), () => renderTeam(el));
    return;
  }
  const { data: players } = await sb.from('players').select('steamid,name').order('last_seen', { ascending: false });
  const steamOptions = (players || []);
  const ms = team.playbook.members;
  el.innerHTML = `<div class="card team">
    <div class="team-head">
      <div><h2>Drużyna</h2><p class="muted">Jesteś: <b style="color:${esc(memberColor(me()))}">${esc(me().name)}</b> · <button type="button" class="link" data-act="switch">zmień</button> · <button type="button" class="link" data-act="logout">wyloguj to urządzenie</button></p></div>
    </div>
    <div class="members">${ms.map(m => `
      <form class="member-row" data-id="${esc(m.id)}">
        <input type="color" name="color" value="${esc(m.color || '#ff8a3d')}" title="Kolor">
        <input name="name" value="${esc(m.name)}" maxlength="24" required>
        <select name="steamid">
          <option value="">— konto Steam —</option>
          ${steamOptions.map(p => `<option value="${esc(p.steamid)}" ${p.steamid === m.steamid ? 'selected' : ''}>${esc(p.name || p.steamid)}</option>`).join('')}
        </select>
        <button class="btn small">Zapisz</button>
        <button type="button" class="btn small ghost" data-act="del" title="Usuń">✕</button>
      </form>`).join('')}
    </div>
    <form class="member-row add">
      <input type="color" name="color" value="${MEMBER_COLORS[ms.length % MEMBER_COLORS.length]}">
      <input name="name" placeholder="Nick nowego gracza" maxlength="24" required>
      <button class="btn small primary">+ Dodaj</button>
    </form>
    <p class="muted small">Połączenie z kontem Steam sprawia, że w trybie live widać twoją kasę i HP, a twoje zadanie pojawia się samo.</p>
  </div>` + INSTALL;

  el.querySelector('[data-act="switch"]').onclick = () => { setMe(null); renderTeam(el); };
  el.querySelector('[data-act="logout"]').onclick = () => {
    team.key = null; team.playbook = null; store.set('cs.teamKey', null); setMe(null); emit('playbook'); renderTeam(el);
  };
  el.querySelectorAll('.member-row:not(.add)').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await rpc('save_member', { m: { id: form.dataset.id, name: form.name.value, steamid: form.steamid.value, color: form.color.value } });
        await loadPlaybook();
        toast('Zapisano');
        renderTeam(el);
      } catch (err) {
        toast(err.message.includes('unique') ? 'To konto Steam jest już przypisane komuś innemu' : err.message, 'err');
      }
    });
    form.querySelector('[data-act="del"]').onclick = async () => {
      if (!await confirmBox(`Usunąć ${member(form.dataset.id)?.name} z drużyny?`)) return;
      await rpc('delete_member', { member_id: form.dataset.id });
      if (team.me === form.dataset.id) setMe(null);
      await loadPlaybook();
      renderTeam(el);
    };
  });
  el.querySelector('.member-row.add').addEventListener('submit', async e => {
    e.preventDefault();
    await rpc('save_member', { m: { name: e.target.name.value, color: e.target.color.value } });
    await loadPlaybook();
    renderTeam(el);
  });
}
