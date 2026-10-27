import { Qbt } from '../lib/qbt.js';
import { getConfig, setConfig } from '../lib/config.js';
import { formatSize, formatSpeed, isMagnet } from '../lib/torrent.js';
import { icon } from '../lib/icons.js';
import { $, esc, hydrateIcons } from '../lib/ui.js';
import { initTheme, bindThemeButton } from '../lib/theme.js';
import { loadStorage, driveName, freeLevel } from '../lib/storage.js';

// États qBittorrent 4 (paused*) et 5 (stopped*) : [libellé, famille, icône].
const STATES = {
  downloading: ['Téléchargement', 'dl', 'arrowDown'],
  forcedDL: ['Téléchargement forcé', 'dl', 'arrowDown'],
  metaDL: ['Métadonnées…', 'dl', 'magnet'],
  forcedMetaDL: ['Métadonnées…', 'dl', 'magnet'],
  stalledDL: ['En attente de pairs', 'dl', 'clock'],
  queuedDL: ['En file', 'queued', 'clock'],
  checkingDL: ['Vérification', 'check', 'refresh'],
  checkingUP: ['Vérification', 'check', 'refresh'],
  checkingResumeData: ['Vérification', 'check', 'refresh'],
  pausedDL: ['Arrêté', 'stopped', 'pause'],
  stoppedDL: ['Arrêté', 'stopped', 'pause'],
  uploading: ['Partage', 'seed', 'arrowUp'],
  forcedUP: ['Partage forcé', 'seed', 'arrowUp'],
  stalledUP: ['Terminé', 'seed', 'check'],
  queuedUP: ['Terminé', 'seed', 'check'],
  pausedUP: ['Terminé', 'seed', 'checkCircle'],
  stoppedUP: ['Terminé', 'seed', 'checkCircle'],
  moving: ['Déplacement', 'check', 'move'],
  missingFiles: ['Fichiers manquants', 'error', 'alert'],
  error: ['Erreur', 'error', 'alert'],
};
const CONNECTION = {
  connected: ['Connecté', 'ok'],
  firewalled: ['Derrière un pare-feu', 'warn'],
  disconnected: ['Réseau déconnecté', 'err'],
};
const HISTORY = 30;

const isStopped = (t) => /^(paused|stopped)/.test(t.state);
const FILTERS = {
  all: () => true,
  dl: (t) => t.progress < 1 && !isStopped(t) && STATES[t.state]?.[1] !== 'error',
  done: (t) => t.progress >= 1,
  stopped: isStopped,
};

const DISKS_REFRESH = 30000;

const data = { rid: 0, torrents: {}, server: {}, categories: {} };
const hist = { dl: [], ul: [] };
const disks = { storage: null, at: 0, loading: false, prefs: null };
let cfg;
let qbt;
let filter = 'all';
let search = '';
let lastHtml = '';
let timer;

function formatEta(s) {
  if (!s || s >= 8640000) return '';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${s} s`;
}

function spark(svg, values) {
  const pts = values.slice(-HISTORY);
  if (pts.length < 2) { svg.innerHTML = ''; return; }
  const max = Math.max(...pts, 1);
  const step = 100 / (pts.length - 1);
  const coords = pts.map((v, i) => [i * step, 31 - (v / max) * 26]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
  svg.innerHTML = `<path class="area" d="${line}L100,32L${coords[0][0].toFixed(2)},32Z"/><path class="line" d="${line}"/>`;
}

function renderStats() {
  const s = data.server;
  $('dl').textContent = formatSpeed(s.dl_info_speed || 0);
  $('ul').textContent = formatSpeed(s.up_info_speed || 0);
  $('dlSub').textContent = s.dl_rate_limit > 0 ? `Limite ${formatSpeed(s.dl_rate_limit)}` : `Session : ${formatSize(s.dl_info_data || 0)}`;
  $('ulSub').textContent = s.up_rate_limit > 0 ? `Limite ${formatSpeed(s.up_rate_limit)}` : `Session : ${formatSize(s.up_info_data || 0)}`;
  spark($('dlSpark'), hist.dl);
  spark($('ulSpark'), hist.ul);
  $('free').textContent = s.free_space_on_disk != null ? `${formatSize(s.free_space_on_disk)} libres` : '–';

  const [label, kind] = CONNECTION[s.connection_status] || ['Connecté', 'ok'];
  $('dot').className = `dot ${kind}`;
  $('statusText').textContent = label;

  $('altBtn').hidden = s.use_alt_speed_limits == null;
  $('altBtn').classList.toggle('is-on', Boolean(s.use_alt_speed_limits));
  $('altBtn').title = s.use_alt_speed_limits
    ? 'Limites de vitesse alternatives : activées'
    : 'Limites de vitesse alternatives : désactivées';
}

function renderList() {
  const all = Object.values(data.torrents).sort((a, b) => (b.added_on || 0) - (a.added_on || 0));
  const counts = { all: all.length, dl: 0, done: 0, stopped: 0 };
  for (const t of all) for (const k of ['dl', 'done', 'stopped']) if (FILTERS[k](t)) counts[k]++;
  $('cAll').textContent = counts.all;
  $('cDl').textContent = counts.dl;
  $('cDone').textContent = counts.done;
  $('cStopped').textContent = counts.stopped;

  const q = search.toLowerCase();
  const shown = all.filter((t) => FILTERS[filter](t) && (!q || t.name.toLowerCase().includes(q))).slice(0, cfg.popupCount);

  const html = shown.length ? shown.map((t) => {
    const [label, kind, ic] = STATES[t.state] || [t.state, 'stopped', 'file'];
    const stopped = isStopped(t);
    const pct = Math.floor(t.progress * 1000) / 10;
    let right = '';
    if (t.dlspeed > 0) right = `↓ ${formatSpeed(t.dlspeed)}${formatEta(t.eta) ? ` · ${formatEta(t.eta)}` : ''}`;
    else if (t.upspeed > 0) right = `↑ ${formatSpeed(t.upspeed)}`;
    else if (t.progress >= 1 && t.ratio != null) right = `Ratio ${t.ratio.toFixed(2)}`;
    return `<li class="titem k-${kind}" title="${esc(t.name)}">
      <span class="t-ico">${icon(ic)}</span>
      <span class="t-name">${esc(t.name)}</span>
      <button type="button" class="btn btn-ghost btn-icon btn-sm t-act" data-hash="${esc(t.hash)}" data-action="${stopped ? 'start' : 'stop'}" title="${stopped ? 'Démarrer' : 'Arrêter'}">${icon(stopped ? 'play' : 'pause')}</button>
      <div class="t-bar"><span style="width:${pct}%"></span></div>
      <div class="t-meta"><span><span class="state">${esc(label)}</span> · ${pct} % · ${formatSize(t.size)}</span><span>${right}</span></div>
    </li>`;
  }).join('') : `<li class="empty">${icon(q ? 'search' : 'inbox')}<span>${q ? 'Aucun résultat' : 'Aucun torrent ici'}</span></li>`;

  if (html !== lastHtml) {
    $('list').innerHTML = html;
    lastHtml = html;
  }
}

// ---------------------------------------------------------------------------
// Disques du serveur

function openFiles(path = '') {
  const url = chrome.runtime.getURL(`src/files/files.html${path ? `?path=${encodeURIComponent(path)}` : ''}`);
  chrome.tabs.create({ url });
  window.close();
}

async function loadDisks(refresh = false) {
  if (disks.loading) return;
  disks.loading = true;
  if (refresh) {
    disks.storage = null;
    renderDisks();
  }
  try {
    disks.prefs ??= await qbt.preferences().catch(() => ({}));
    disks.storage = await loadStorage(qbt, {
      serverUrl: cfg.serverUrl,
      prefs: disks.prefs,
      torrents: Object.values(data.torrents),
      categories: data.categories,
      defaultFree: data.server.free_space_on_disk,
      refresh,
    });
  } catch (e) {
    disks.storage = { drives: [], error: e.message };
  }
  disks.at = Date.now();
  disks.loading = false;
  renderDisks();
}

function renderDisks() {
  const open = Boolean(cfg.popupDisks);
  $('disks').hidden = !open;
  $('disksBtn').classList.toggle('is-on', open);
  $('disksBtn').title = open ? 'Masquer les disques du serveur' : 'Afficher les disques du serveur';
  if (!open) return;
  const s = disks.storage;
  if (!s) {
    $('dlist').innerHTML = '<li class="dempty"><span class="spinner"></span>Recherche des disques…</li>';
    return;
  }
  const rows = s.drives.map((d) => {
    const u = d.usage;
    const short = d.free != null && u?.remaining > d.free;
    const level = d.missing ? '' : freeLevel(d.free, u?.remaining || 0);
    const free = d.missing ? 'introuvable' : d.free != null ? `<b>${formatSize(d.free)}</b> libres` : 'libre : ?';
    const meta = u
      ? `${u.count} torrent${u.count > 1 ? 's' : ''} · ${formatSize(u.done)}${u.remaining ? ` · <span${short ? ' class="short"' : ''}>${formatSize(u.remaining)} à télécharger</span>` : ''}`
      : 'Aucun torrent';
    return `<li class="ditem lvl-${level || 'none'}${d.missing ? ' missing' : ''}" data-root="${esc(d.root)}" title="${esc(d.root)} — ouvrir dans l'explorateur">
      <span class="d-ico">${icon(d.kind === 'network' ? 'network' : 'hardDrive')}</span>
      <div class="d-main">
        <div class="d-top"><span class="d-name">${esc(driveName(d.root, cfg.driveNames))}</span><span class="d-free">${free}</span></div>
        <div class="d-meta">${meta}</div>
      </div>
    </li>`;
  });
  if (s.error) rows.push(`<li class="dnote">${icon('alert')}<span>${esc(s.error)}</span></li>`);
  else if (!rows.length) rows.push(`<li class="dnote">${icon('info')}<span>Aucun disque trouvé.</span></li>`);
  if (s.freeApi === false && s.drives.length > 1) {
    rows.push(`<li class="dnote">${icon('info')}<span>Espace libre de chaque disque : qBittorrent 5.3 ou plus récent requis.</span></li>`);
  }
  $('dlist').innerHTML = rows.join('');
}

async function poll() {
  clearTimeout(timer);
  try {
    const r = await qbt.maindata(data.rid);
    if (r.full_update) {
      data.torrents = {};
      data.server = {};
      data.categories = {};
    }
    data.rid = r.rid;
    for (const [hash, t] of Object.entries(r.torrents || {})) {
      data.torrents[hash] = { ...(data.torrents[hash] || {}), ...t, hash };
    }
    for (const hash of r.torrents_removed || []) delete data.torrents[hash];
    Object.assign(data.server, r.server_state || {});
    Object.assign(data.categories, r.categories || {});
    for (const name of r.categories_removed || []) delete data.categories[name];
    hist.dl.push(data.server.dl_info_speed || 0);
    hist.ul.push(data.server.up_info_speed || 0);
    if (hist.dl.length > HISTORY) { hist.dl.shift(); hist.ul.shift(); }
    $('err').hidden = true;
    renderStats();
    renderList();
    if (cfg.popupDisks && Date.now() - disks.at > DISKS_REFRESH) loadDisks();
  } catch (e) {
    data.rid = 0;
    $('dot').className = 'dot err';
    $('statusText').textContent = 'Hors ligne';
    $('errText').textContent = e.message;
    $('err').hidden = false;
  }
  timer = setTimeout(poll, cfg.popupRefresh * 1000);
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
  $('feedsBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/feeds/feeds.html') });
    window.close();
  });
  $('setupBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  if (!cfg.serverUrl) {
    $('setup').hidden = false;
    $('srv').textContent = 'Non configuré';
    document.querySelector('.foot').hidden = true;
    return;
  }

  $('content').hidden = false;
  $('srv').textContent = new URL(cfg.serverUrl).host;
  $('webui').addEventListener('click', () => chrome.tabs.create({ url: `${cfg.serverUrl}/` }));
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
      if (btn.dataset.action === 'start') await qbt.start(btn.dataset.hash);
      else await qbt.stop(btn.dataset.hash);
    } finally {
      poll();
    }
  });
  $('altBtn').addEventListener('click', async () => {
    await qbt.toggleAltSpeed();
    poll();
  });

  $('filesBtn').hidden = false;
  $('filesBtn').addEventListener('click', () => openFiles());
  $('disksOpen').addEventListener('click', () => openFiles());
  $('disksRefresh').addEventListener('click', () => loadDisks(true));
  $('disksBtn').addEventListener('click', () => {
    cfg.popupDisks = !cfg.popupDisks;
    setConfig({ popupDisks: cfg.popupDisks });
    renderDisks();
    if (cfg.popupDisks && !disks.storage && data.rid) loadDisks();
  });
  $('dlist').addEventListener('click', (e) => {
    const li = e.target.closest('[data-root]');
    if (li) openFiles(li.dataset.root);
  });
  renderDisks();

  qbt = new Qbt(cfg);
  qbt.version().then((v) => { $('srv').textContent = `${new URL(cfg.serverUrl).host} · ${v}`; }).catch(() => {});
  poll();
}

main();
