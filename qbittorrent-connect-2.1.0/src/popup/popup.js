import { createClient } from '../lib/clients/index.js';
import { getConfig, setConfig } from '../lib/config.js';
import { formatSize, formatSpeed, isMagnet } from '../lib/torrent.js';
import { QUALITY_LABELS, LANG_LABELS } from '../lib/media.js';
import { icon } from '../lib/icons.js';
import { $, esc, hydrateIcons, toast } from '../lib/ui.js';
import { initTheme, bindThemeButton } from '../lib/theme.js';

// États normalisés : [libellé, famille de couleur, icône].
const STATES = {
  downloading: ['Téléchargement', 'dl', 'arrowDown'],
  metadata: ['Métadonnées…', 'dl', 'magnet'],
  stalled: ['En attente de pairs', 'dl', 'clock'],
  queued: ['En file', 'queued', 'clock'],
  checking: ['Vérification', 'check', 'refresh'],
  stopped: ['Arrêté', 'stopped', 'pause'],
  seeding: ['Partage', 'seed', 'arrowUp'],
  completed: ['Terminé', 'seed', 'checkCircle'],
  moving: ['Déplacement', 'check', 'move'],
  error: ['Erreur', 'error', 'alert'],
};
const CONNECTION = {
  connected: ['Connecté', 'ok'],
  firewalled: ['Derrière un pare-feu', 'warn'],
  disconnected: ['Réseau déconnecté', 'err'],
};
const HISTORY = 30;

const isStopped = (t) => t.state === 'stopped' || t.state === 'completed';
const FILTERS = {
  all: () => true,
  dl: (t) => t.progress < 1 && !isStopped(t) && t.state !== 'error',
  done: (t) => t.progress >= 1,
  stopped: isStopped,
};

const hist = { dl: [], ul: [] };
let cfg;
let client;
let data = { server: {}, torrents: [] };
let filter = 'all';
let search = '';
let lastHtml = '';
let timer;

function formatEta(s) {
  if (!s) return '';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

function whenLabel(date) {
  const day = new Date(`${date}T12:00:00`);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0) return "aujourd'hui";
  if (diff === 1) return 'demain';
  if (diff > 1 && diff < 7) return day.toLocaleDateString('fr-FR', { weekday: 'long' });
  return day.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function spark(svg, values) {
  const pts = values.slice(-HISTORY);
  if (pts.length < 2) { svg.innerHTML = ''; return; }
  const max = Math.max(...pts, 1);
  const step = 100 / (pts.length - 1);
  const coords = pts.map((v, i) => [i * step, 31 - (v / max) * 26]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
  svg.innerHTML = `<path class="area" d="${line}L100,32L0,32Z"/><path class="line" d="${line}"/>`;
}

// ---------------------------------------------------------------------------
// Torrents

function renderStats() {
  const s = data.server;
  $('dl').textContent = formatSpeed(s.dlSpeed || 0);
  $('ul').textContent = formatSpeed(s.upSpeed || 0);
  const sub = (limit, session) => (limit > 0 ? `Limite ${formatSpeed(limit)}` : session ? `Session : ${formatSize(session)}` : '');
  $('dlSub').textContent = sub(s.dlLimit, s.dlSession);
  $('ulSub').textContent = sub(s.upLimit, s.upSession);
  spark($('dlSpark'), hist.dl);
  spark($('ulSpark'), hist.ul);
  $('freePill').hidden = s.freeSpace == null;
  if (s.freeSpace != null) $('free').textContent = `${formatSize(s.freeSpace)} libres`;

  const [label, kind] = CONNECTION[s.connection] || CONNECTION.connected;
  $('dot').className = `dot ${kind}`;
  $('statusText').textContent = label;

  $('altBtn').hidden = !client.caps.altSpeed || s.altSpeed == null;
  $('altBtn').classList.toggle('is-on', Boolean(s.altSpeed));
  $('altBtn').title = s.altSpeed ? 'Limites de vitesse alternatives : activées' : 'Limites de vitesse alternatives : désactivées';
}

function renderList() {
  const all = [...data.torrents].sort((a, b) => (b.addedOn || 0) - (a.addedOn || 0));
  const counts = { all: all.length, dl: 0, done: 0, stopped: 0 };
  for (const t of all) for (const k of ['dl', 'done', 'stopped']) if (FILTERS[k](t)) counts[k]++;
  $('cAll').textContent = counts.all;
  $('cDl').textContent = counts.dl;
  $('cDone').textContent = counts.done;
  $('cStopped').textContent = counts.stopped;

  const q = search.toLowerCase();
  const shown = all.filter((t) => FILTERS[filter](t) && (!q || t.name.toLowerCase().includes(q))).slice(0, cfg.popupCount);
  const canAct = client.caps.startStop;

  const html = shown.length ? shown.map((t) => {
    const [label, kind, ic] = STATES[t.state] || STATES.stopped;
    const stopped = isStopped(t);
    const pct = Math.floor(t.progress * 1000) / 10;
    let right = '';
    if (t.dlspeed > 0) right = `↓ ${formatSpeed(t.dlspeed)}${t.eta ? ` · ${formatEta(t.eta)}` : ''}`;
    else if (t.upspeed > 0) right = `↑ ${formatSpeed(t.upspeed)}`;
    else if (t.progress >= 1 && t.ratio != null) right = `Ratio ${Number(t.ratio).toFixed(2)}`;
    return `<li class="titem k-${kind}" title="${esc(t.name)}">
      <span class="t-ico">${icon(ic)}</span>
      <span class="t-name">${esc(t.name)}</span>
      ${canAct ? `<button type="button" class="btn btn-ghost btn-icon btn-sm t-act" data-hash="${esc(t.hash)}" data-action="${stopped ? 'start' : 'stop'}" title="${stopped ? 'Démarrer' : 'Arrêter'}">${icon(stopped ? 'play' : 'pause')}</button>` : ''}
      <div class="t-bar"><span style="width:${pct}%"></span></div>
      <div class="t-meta"><span><span class="state">${esc(label)}</span> · ${pct} % · ${formatSize(t.size)}</span><span>${right}</span></div>
    </li>`;
  }).join('') : `<li class="empty">${icon(q ? 'search' : 'inbox')}<span>${q ? 'Aucun résultat' : 'Aucun torrent ici'}</span></li>`;

  if (html !== lastHtml) {
    $('list').innerHTML = html;
    lastHtml = html;
  }
}

async function poll() {
  clearTimeout(timer);
  try {
    data = await client.poll();
    hist.dl.push(data.server.dlSpeed || 0);
    hist.ul.push(data.server.upSpeed || 0);
    if (hist.dl.length > HISTORY) { hist.dl.shift(); hist.ul.shift(); }
    $('err').hidden = true;
    renderStats();
    renderList();
  } catch (e) {
    $('dot').className = 'dot err';
    $('statusText').textContent = 'Hors ligne';
    $('errText').textContent = e.message;
    $('err').hidden = false;
  }
  timer = setTimeout(poll, cfg.popupRefresh * 1000);
}

// ---------------------------------------------------------------------------
// Sorties

async function renderReleases() {
  const store = await chrome.storage.local.get({ releaseAlerts: [], feedState: {} });
  const alerts = store.releaseAlerts;
  // Une source (flux RSS ou indexeur) et quelque chose à suivre (série ou film).
  const configured = (cfg.feeds.length || cfg.indexers.length) && (cfg.followed.length || cfg.movies.length);
  $('relSetup').hidden = Boolean(configured);

  const unread = alerts.filter((a) => !a.read).length;
  $('unreadBadge').hidden = !unread;
  $('unreadBadge').textContent = unread;

  const checks = Object.values(store.feedState).map((s) => s.lastCheck).filter(Boolean);
  $('checkInfo').textContent = checks.length ? `Vérifié ${timeAgo(Math.max(...checks))}` : '';

  $('relList').innerHTML = alerts.length ? alerts.slice(0, 20).map((a) => `
    <li class="ritem${a.read ? '' : ' unread'}">
      ${a.poster ? `<img class="r-poster" src="${esc(a.poster)}" alt="">` : `<span class="r-poster">${icon(a.kind === 'movie' ? 'clapperboard' : 'tv')}</span>`}
      <div class="r-body">
        <div class="r-title"><span>${esc(a.showName)}</span>${a.code ? `<span class="r-code">${esc(a.code)}</span>` : ''}${a.kind === 'missing' ? '<span class="r-code r-missing">Manquant</span>' : ''}</div>
        <div class="r-release" title="${esc(a.title)}">${esc(a.title)}</div>
        <div class="r-meta">
          <span class="grow">${esc([a.feedName, timeAgo(a.foundAt), ...(a.choice ? [a.choice] : [QUALITY_LABELS[a.quality], LANG_LABELS[a.lang]])].filter(Boolean).join(' · '))}</span>
          <span class="r-actions">
            ${a.downloaded ? `<span class="r-done">${icon('check')}Envoyé</span>` : `<button type="button" class="btn btn-primary btn-sm btn-icon" data-dl="${esc(a.id)}" title="Télécharger">${icon('download')}</button>`}
            <button type="button" class="btn btn-sm btn-icon" data-open="${esc(a.id)}" title="Voir le torrent">${icon('external')}</button>
          </span>
        </div>
      </div>
    </li>`).join('') : configured ? `<li class="rel-empty">Aucune sortie pour l'instant. Les nouveaux épisodes de tes séries et tes films suivis apparaîtront ici.</li>` : '';

  const upcoming = cfg.followed
    .filter((s) => s.next?.airdate && s.next.airdate >= new Date().toISOString().slice(0, 10))
    .sort((a, b) => a.next.airdate.localeCompare(b.next.airdate))
    .slice(0, 6);
  $('upcomingBox').hidden = !upcoming.length;
  $('upcoming').innerHTML = upcoming.map((s) => `
    <li class="uitem">
      ${s.poster ? `<img class="u-poster" src="${esc(s.poster)}" alt="">` : '<span class="u-poster"></span>'}
      <div class="u-body"><b>${esc(s.name)}</b><span>S${String(s.next.season).padStart(2, '0')}E${String(s.next.number).padStart(2, '0')}${s.next.name ? ` · ${esc(s.next.name)}` : ''}</span></div>
      <span class="u-when">${esc(whenLabel(s.next.airdate))}</span>
    </li>`).join('');
}

function showPanel(panel) {
  const torrents = panel !== 'releases';
  $('content').hidden = !torrents || !cfg.serverUrl;
  $('setup').hidden = !torrents || Boolean(cfg.serverUrl);
  $('releases').hidden = torrents;
  $('foot').hidden = !torrents || !cfg.serverUrl;
  document.querySelector(`#mainTabs input[value="${torrents ? 'torrents' : 'releases'}"]`).checked = true;
  if (!torrents) {
    renderReleases();
    // Ouvrir l'onglet vaut lecture : le badge de l'icône disparaît.
    setTimeout(() => chrome.runtime.sendMessage({ type: 'alerts-read-all' }), 1500);
  }
}

async function openAdd(payload) {
  await chrome.runtime.sendMessage({ type: 'open-add', data: payload });
  window.close();
}

async function main() {
  hydrateIcons();
  await initTheme();
  bindThemeButton($('themeBtn'));
  cfg = await getConfig();

  $('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('setupBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('relSetupBtn').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#series') }));
  $('mainTabs').hidden = false;
  $('mainTabs').addEventListener('change', (e) => {
    setConfig({ popupTab: e.target.value });
    showPanel(e.target.value);
  });

  $('relList').addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl]');
    const open = e.target.closest('[data-open]');
    if (dl) {
      dl.disabled = true;
      await chrome.runtime.sendMessage({ type: 'alert-download', id: dl.dataset.dl });
      window.close();
    } else if (open) {
      await chrome.runtime.sendMessage({ type: 'alert-open', id: open.dataset.open });
      window.close();
    }
  });
  $('checkNow').addEventListener('click', async () => {
    const btn = $('checkNow');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    const r = await chrome.runtime.sendMessage({ type: 'check-feeds' });
    btn.disabled = false;
    btn.innerHTML = icon('refresh');
    if (!r?.ok) toast(r?.error || 'Vérification impossible', 'error');
    else if (r.value.errors?.length) toast(`${r.value.errors[0].feed} : ${r.value.errors[0].error}`, 'error');
    else toast(r.value.fresh ? `${r.value.fresh} nouvelle(s) sortie(s)` : 'Rien de nouveau', 'ok');
    renderReleases();
  });

  if (cfg.serverUrl) {
    client = createClient(cfg);
    $('srv').textContent = `${client.label} · ${new URL(cfg.serverUrl).host}`;
    $('webui').addEventListener('click', () => chrome.tabs.create({ url: client.webUrl }));
    $('addFile').addEventListener('click', () => openAdd({ kind: 'empty' }));
    $('quickAdd').addEventListener('submit', (e) => {
      e.preventDefault();
      const link = $('quickLink').value.trim();
      if (isMagnet(link)) openAdd({ kind: 'magnet', url: link });
      else if (/^https?:\/\//i.test(link)) openAdd({ kind: 'url', url: link });
      else $('quickLink').focus();
    });

    filter = FILTERS[cfg.popupFilter] ? cfg.popupFilter : 'all';
    document.querySelector(`#tabs input[value="${filter}"]`).checked = true;
    $('tabs').addEventListener('change', (e) => {
      filter = e.target.value;
      setConfig({ popupFilter: filter });
      renderList();
    });
    $('searchBtn').addEventListener('click', () => {
      $('searchBox').hidden = !$('searchBox').hidden;
      $('searchBtn').classList.toggle('is-on', !$('searchBox').hidden);
      if (!$('searchBox').hidden) $('search').focus();
      else { search = ''; $('search').value = ''; renderList(); }
    });
    $('search').addEventListener('input', (e) => { search = e.target.value.trim(); renderList(); });

    $('list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      btn.disabled = true;
      try {
        if (btn.dataset.action === 'start') await client.start(btn.dataset.hash);
        else await client.stop(btn.dataset.hash);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        poll();
      }
    });
    $('altBtn').addEventListener('click', async () => {
      await client.toggleAltSpeed().catch((err) => toast(err.message, 'error'));
      poll();
    });
    client.test().then((t) => { $('srv').textContent = `${t.version} · ${new URL(cfg.serverUrl).host}`; }).catch(() => {});
    poll();
  } else {
    $('srv').textContent = 'Aucun client configuré';
  }

  await renderReleases();
  const unread = Number($('unreadBadge').textContent) || 0;
  showPanel(unread ? 'releases' : cfg.popupTab);
}

main();
