// Tabs, team unlock and module wiring.
import { store, on, loadCallStats } from './core.js';
import { boot, needsGate, renderGate, renderTeam } from './gate.js';
import { initStats } from './stats.js';
import { renderTactics } from './tactics.js';
import { renderLineups } from './lineups.js';
import { renderLive, startLive, stopLive } from './live.js';

const TEAM_TABS = { live: renderLive, tactics: renderTactics, lineups: renderLineups };
let current = store.get('cs.tab') || 'live';

function panel(tab) {
  return document.getElementById('tab-' + tab);
}

function show(tab) {
  current = tab;
  store.set('cs.tab', tab);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
  // The live tab shows the same game in detail, so the "playing now" strip would only repeat it.
  document.getElementById('live').classList.toggle('on-live-tab', tab === 'live');
  if (tab !== 'live') stopLive();
  if (tab === 'team') { renderTeam(panel('team')); return; }
  const render = TEAM_TABS[tab];
  if (!render) return;
  if (needsGate()) {
    renderGate(panel(tab), () => show(tab));
    return;
  }
  render(panel(tab));
  if (tab === 'live') startLive();
}

document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));

// Playbook changed (saved here or reloaded): redraw the open team tab under any modal.
on('playbook', () => { if (TEAM_TABS[current] && !needsGate()) TEAM_TABS[current](panel(current)); });
on('callstats', () => { if (current === 'tactics' && !needsGate()) renderTactics(panel('tactics')); });

initStats();
boot().finally(() => {
  loadCallStats();
  show(current);
});

if ('serviceWorker' in navigator) {
  // A new SW took over: reload to pick up the new code (not on the very first install).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed:', err));
  });
}
