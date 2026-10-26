import { getConfig, applyHeaderRule } from './lib/config.js';
import { createClient } from './lib/clients/index.js';
import { toBase64 } from './lib/clients/base.js';
import { parseTorrent, parseMagnet } from './lib/torrent.js';
import { planDestination } from './lib/organize.js';
import {
  checkFeeds, loadAlerts, updateAlert, markAll, takePending, refreshSchedules, updateBadge, addAlerts,
} from './lib/alerts.js';
import { SYNC_KEYS, push, pull, reconcile, dropSecrets } from './lib/sync.js';
import { runWanted, markGrabbed } from './lib/wanted.js';
import { findEpisode, findMovie, hasIndexer } from './lib/indexer.js';
import { rankReleases, profileOf } from './lib/quality.js';
import { episodeCode } from './lib/media.js';

const MENU_ID = 'qbt-add-link';
const WINDOW_SIZES = {
  normal: { width: 1100, height: 820 },
  large: { width: 1320, height: 940 },
};

async function setup() {
  // Récupère d'abord les réglages des autres PC (synchronisation Chrome).
  await reconcile().catch(() => {});
  const cfg = await getConfig();
  await applyHeaderRule(cfg.serverUrl);
  await scheduleAlarms(cfg);
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Envoyer au client torrent', contexts: ['link'] });
  });
  await setup();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(setup);

function notify(cfg, title, message, id) {
  if (!cfg.notifications) return;
  chrome.notifications.create(id || '', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}

// ---------------------------------------------------------------------------
// Ajout de torrents

// Ouvre la fenêtre d'ajout. Les données de la source (fichier téléchargé, URL,
// magnet) passent par storage.session, la fenêtre les relit via son paramètre id.
async function openAddDialog(data, cfg) {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`pending:${id}`]: data });

  const { width, height } = WINDOW_SIZES[cfg.windowSize] || WINDOW_SIZES.normal;
  let left;
  let top;
  try {
    const win = await chrome.windows.getLastFocused();
    if (win?.width) {
      left = Math.max(0, Math.round(win.left + (win.width - width) / 2));
      top = Math.max(0, Math.round(win.top + (win.height - height) / 2));
    }
  } catch { /* pas de fenêtre au premier plan */ }

  await chrome.windows.create({
    url: chrome.runtime.getURL(`src/add/add.html?id=${id}`),
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true,
  });
}

async function fetchTorrentBytes(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes[0] === 0x64 ? bytes : null;
  } catch {
    return null;
  }
}

// Ajout sans fenêtre, avec rangement automatique. Lève une erreur « illisible »
// si le .torrent ne peut pas être lu, pour basculer sur la fenêtre d'ajout.
async function quickAdd(data, cfg) {
  const client = createClient(cfg);
  const req = { paused: false };
  let name = data.name || '';
  if (data.kind === 'magnet') {
    const m = parseMagnet(data.url);
    Object.assign(req, { url: data.url, hash: m.id });
    name = name || m.name;
  } else {
    const url = data.kind === 'download' ? (data.finalUrl || data.url) : data.url;
    const bytes = await fetchTorrentBytes(url);
    if (bytes) {
      const t = await parseTorrent(bytes);
      Object.assign(req, { torrent: bytes, filename: `${t.name}.torrent`, hash: t.id });
      name = t.name;
    } else if (data.kind === 'url') {
      req.url = url;
      name = name || url;
    } else {
      throw Object.assign(new Error('torrent illisible'), { code: 'UNREADABLE' });
    }
  }

  const plan = await planDestination(client, cfg, name).catch(() => null);
  if (plan?.path) {
    Object.assign(req, { savePath: plan.path, autoTMM: false });
    if (plan.category && client.caps.categories) req.category = plan.category;
    if (plan.layout && client.caps.contentLayout) req.contentLayout = plan.layout;
  } else {
    if (cfg.defaultCategory && client.caps.categories) req.category = cfg.defaultCategory;
    if (cfg.rememberLastPath && cfg.recentPaths[0]) Object.assign(req, { savePath: cfg.recentPaths[0], autoTMM: false });
  }

  await client.add(req);

  if (data.kind === 'download' && cfg.deleteLocalTorrent) {
    try { await chrome.downloads.removeFile(data.downloadId); } catch { /* déjà supprimé */ }
    try { await chrome.downloads.erase({ id: data.downloadId }); } catch { /* idem */ }
  }
  notify(cfg, `Torrent envoyé à ${client.label}`, req.savePath ? `${name}\n→ ${req.savePath}` : name);
}

async function handleIncoming(data, { direct = false } = {}) {
  const cfg = await getConfig();
  if ((direct || cfg.addMode === 'direct') && data.kind !== 'empty') {
    try {
      await quickAdd(data, cfg);
      return;
    } catch (e) {
      // Lecture ou envoi impossible : la fenêtre d'ajout prend le relais.
      if (e.code !== 'UNREADABLE') notify(cfg, "Échec de l'ajout direct", e.message);
    }
  }
  await openAddDialog(data, cfg);
}

function isTorrentDownload(item) {
  return item.mime === 'application/x-bittorrent' || /\.torrent$/i.test(item.filename || '');
}

// Un .torrent vient d'être téléchargé : on laisse Chrome le finir (c'est le plus
// fiable, même pour les liens à usage unique), puis on le traite.
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== 'complete') return;
  const cfg = await getConfig();
  if (!cfg.interceptTorrents || !cfg.serverUrl) return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (!item || item.byExtensionId === chrome.runtime.id || !isTorrentDownload(item)) return;
  await handleIncoming({
    kind: 'download',
    downloadId: item.id,
    url: item.url,
    finalUrl: item.finalUrl,
    referrer: item.referrer,
    filename: item.filename,
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID || !info.linkUrl) return;
  if (/^magnet:/i.test(info.linkUrl)) handleIncoming({ kind: 'magnet', url: info.linkUrl });
  else handleIncoming({ kind: 'url', url: info.linkUrl, referrer: info.pageUrl });
});

// ---------------------------------------------------------------------------
// Alertes de sorties

async function ensureAlarm(name, on, period, delay = 1) {
  if (!on) {
    await chrome.alarms.clear(name);
    return;
  }
  const existing = await chrome.alarms.get(name);
  if (!existing || existing.periodInMinutes !== period) await chrome.alarms.create(name, { delayInMinutes: delay, periodInMinutes: period });
}

async function scheduleAlarms(cfg) {
  const watching = cfg.followed.length || (cfg.movies || []).length;
  const sources = cfg.feeds.some((f) => f.enabled !== false) || hasIndexer(cfg);
  await ensureAlarm('feeds', cfg.alertsEnabled && sources && watching, Math.max(5, Number(cfg.checkInterval) || 30));
  await ensureAlarm('schedules', cfg.followed.length > 0, 360, 2);
  await ensureAlarm('wanted', cfg.alertsEnabled && hasIndexer(cfg) && watching, Math.max(30, Number(cfg.wantedInterval) || 120), 3);
}

// Synchronisation : envoi groupé des réglages modifiés, réception des autres PC.
let pushTimer;
const pendingPush = new Set();
let pullTimer;

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync') {
    clearTimeout(pullTimer);
    pullTimer = setTimeout(() => pull().catch(() => {}), 1500);
    return;
  }
  if (area !== 'local') return;
  if (changes.syncEnabled?.newValue || changes.syncSecrets?.newValue) reconcile().catch(() => {});
  if (changes.syncSecrets && !changes.syncSecrets.newValue) dropSecrets().catch(() => {});
  const keys = Object.keys(changes).filter((k) => SYNC_KEYS.includes(k));
  if (keys.length) {
    keys.forEach((k) => pendingPush.add(k));
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      const list = [...pendingPush];
      pendingPush.clear();
      push(list).catch(() => {});
    }, 2000);
  }
  if (['alertsEnabled', 'feeds', 'indexers', 'followed', 'movies', 'checkInterval', 'wantedInterval'].some((k) => k in changes)) {
    scheduleAlarms(await getConfig());
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'feeds') runCheck();
  if (alarm.name === 'schedules') refreshSchedules();
  if (alarm.name === 'wanted') checkWanted();
});

const torrentKind = (url) => (/^magnet:/i.test(url) ? 'magnet' : 'url');

async function posterDataUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/jpeg';
    return `data:${type};base64,${toBase64(new Uint8Array(await res.arrayBuffer()))}`;
  } catch {
    return null;
  }
}

// Affiche les alertes dans l'onglet actif ; sinon elles restent en attente et
// s'afficheront au prochain chargement de page.
async function showInActiveTab(alerts) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) return false;
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'show-alerts', alerts });
    return Boolean(r?.ok);
  } catch {
    return false;
  }
}

async function deliver(fresh) {
  if (!fresh.length) return;
  const cfg = await getConfig();
  const toShow = fresh.filter((a) => !a.autoDownload);

  if (cfg.alertDisplay !== 'notification' && toShow.length && await showInActiveTab(toShow)) {
    for (const a of toShow) await updateAlert(a.id, { shown: true });
  }
  if (cfg.alertDisplay !== 'banner') {
    for (const a of fresh.slice(0, 3)) {
      const what = a.kind === 'movie' ? a.showName : `${a.showName} ${a.code}`;
      chrome.notifications.create(`alert:${a.id}`, {
        type: 'basic',
        iconUrl: (await posterDataUrl(a.poster)) || chrome.runtime.getURL('icons/icon128.png'),
        title: a.autoDownload ? `${what} : téléchargement lancé`
          : a.kind === 'missing' ? `${what} : épisode manquant` : `${what} est disponible`,
        message: a.choice ? `${a.choice}\n${a.title}` : a.title,
        contextMessage: a.feedName,
        buttons: a.autoDownload ? [{ title: 'Voir le torrent' }] : [{ title: 'Télécharger' }, { title: 'Voir le torrent' }],
        priority: 1,
      });
    }
  }
}

// Envoie une release au client (sans fenêtre) et la note comme récupérée.
async function grab(release, { showId, season, episode, episodes, movieId, direct = true } = {}) {
  await handleIncoming({ kind: torrentKind(release.torrentUrl), url: release.torrentUrl, referrer: release.link, name: release.title }, { direct });
  await markGrabbed({ showId, season, episode, episodes, movieId, title: release.title });
}

// Meilleure release pour une alerte : recherche complète sur les indexeurs si
// possible (pour comparer toutes les versions), sinon parmi celles du flux.
async function bestForAlert(a) {
  const cfg = await getConfig();
  if (hasIndexer(cfg)) {
    try {
      if (a.kind === 'movie') {
        const movie = cfg.movies.find((m) => m.id === a.movieId);
        if (movie) {
          const r = await findMovie(cfg, movie);
          if (r.best) return r.best;
        }
      } else if (a.episode != null) {
        const show = cfg.followed.find((s) => s.id === a.showId);
        if (show) {
          const r = await findEpisode(cfg, show, a.season, a.episode);
          if (r.best) return r.best;
        }
      }
    } catch { /* on se rabat sur les releases du flux */ }
  }
  return rankReleases(a.releases || [], profileOf(cfg)).best;
}

async function runCheck() {
  const result = await checkFeeds();
  // Téléchargement automatique pour les séries et films qui l'ont demandé.
  for (const a of result.fresh.filter((x) => x.autoDownload)) {
    try {
      const best = await bestForAlert(a);
      if (!best) {
        // Aucune version ne respecte le profil de qualité : on prévient au lieu de télécharger.
        await updateAlert(a.id, { autoDownload: false });
        a.autoDownload = false;
        continue;
      }
      await grab(best.item, { showId: a.showId, season: a.season, episode: a.episode, movieId: a.movieId });
      await updateAlert(a.id, { downloaded: true, shown: true, title: best.item.title, choice: best.label });
    } catch { /* l'alerte reste affichable */ }
  }
  await deliver(result.fresh);
  return { fresh: result.fresh.length, errors: result.errors, checked: result.checked };
}

async function downloadAlert(id) {
  const alerts = await loadAlerts();
  const a = alerts.find((x) => x.id === id);
  if (!a) return;
  await updateAlert(id, { downloaded: true, read: true, shown: true });
  const best = await bestForAlert(a).catch(() => null);
  const release = best?.item || { torrentUrl: a.torrentUrl, link: a.link, title: a.title };
  // Une release choisie par le profil part directement ; sinon on respecte le mode d'ajout.
  const cfg = await getConfig();
  await grab(release, { showId: a.showId, season: a.season, episode: a.episode, movieId: a.movieId, direct: Boolean(best) || cfg.addMode === 'direct' });
}

// Recherche périodique de ce qui manque (épisodes récents, films suivis).
async function checkWanted() {
  const proposals = [];
  const report = await runWanted(async (found) => {
    const r = found.best.item;
    const base = {
      id: crypto.randomUUID(),
      title: r.title,
      link: r.link,
      torrentUrl: r.torrentUrl,
      size: r.size,
      quality: found.best.a.resolution,
      lang: found.best.a.lang,
      choice: found.best.label,
      reason: found.best.reason,
      feedName: r.indexer || 'Indexeur',
      pubDate: r.pubDate,
      foundAt: Date.now(),
      read: false,
      shown: false,
      downloaded: found.auto,
      autoDownload: found.auto,
      releases: [{ title: r.title, link: r.link, torrentUrl: r.torrentUrl, size: r.size }],
    };
    const alert = found.kind === 'movie'
      ? { ...base, key: `movie:${found.movie.id}`, kind: 'movie', movieId: found.movie.id, showName: `${found.movie.title}${found.movie.year ? ` (${found.movie.year})` : ''}`, poster: found.movie.poster || '', code: 'Film' }
      : {
        ...base,
        key: `${found.show.id}:episode:${found.season}:${found.episode}`,
        kind: found.auto ? 'episode' : 'missing',
        showId: found.show.id,
        showName: found.show.name,
        poster: found.show.poster || '',
        season: found.season,
        episode: found.episode,
        code: episodeCode({ kind: 'episode', season: found.season, episode: found.episode }),
      };
    if (found.auto) {
      await grab(r, { showId: found.show?.id, season: found.season, episode: found.episode, movieId: found.movie?.id });
    }
    proposals.push(alert);
  });
  const added = await addAlerts(proposals);
  await deliver(added);
  return { ...report, alerts: added.length };
}

async function openAlert(id) {
  const a = (await loadAlerts()).find((x) => x.id === id);
  if (!a) return;
  await updateAlert(id, { read: true, shown: true });
  await chrome.tabs.create({ url: a.link || a.torrentUrl });
}

chrome.notifications.onClicked.addListener((nid) => {
  if (nid.startsWith('alert:')) openAlert(nid.slice(6));
  chrome.notifications.clear(nid);
});

chrome.notifications.onButtonClicked.addListener(async (nid, index) => {
  if (!nid.startsWith('alert:')) return;
  const id = nid.slice(6);
  const a = (await loadAlerts()).find((x) => x.id === id);
  if (a?.autoDownload || index === 1) openAlert(id);
  else downloadAlert(id);
  chrome.notifications.clear(nid);
});

// ---------------------------------------------------------------------------
// Messages des pages de l'extension et des scripts de contenu

const reply = (promise, sendResponse) => {
  Promise.resolve(promise).then(
    (value) => sendResponse({ ok: true, value }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fromExtensionPage = sender.id === chrome.runtime.id && !sender.tab;
  switch (msg?.type) {
    // Depuis les scripts de contenu.
    case 'magnet':
      if (!/^magnet:/i.test(msg.url || '')) return false;
      return reply(handleIncoming({ kind: 'magnet', url: msg.url }), sendResponse);
    case 'alerts-pending':
      return reply(getConfig().then((cfg) => (cfg.alertsEnabled && cfg.alertDisplay !== 'notification' ? takePending() : [])), sendResponse);
    case 'alert-download':
      return reply(downloadAlert(msg.id), sendResponse);
    case 'alert-open':
      return reply(openAlert(msg.id), sendResponse);
    case 'alert-dismiss':
      return reply(updateAlert(msg.id, { read: true, shown: true }), sendResponse);
    default:
  }
  if (!fromExtensionPage) return false;
  switch (msg?.type) {
    case 'open-add':
      return reply(handleIncoming(msg.data), sendResponse);
    case 'check-feeds':
      return reply(runCheck(), sendResponse);
    case 'alerts-read-all':
      return reply(markAll({ read: true, shown: true }), sendResponse);
    case 'refresh-schedules':
      return reply(refreshSchedules(true), sendResponse);
    case 'run-wanted':
      return reply(checkWanted(), sendResponse);
    case 'grab':
      return reply(grab(msg.release, msg.target || {}), sendResponse);
    case 'sync-now':
      return reply(reconcile().then(async (r) => ({ ...r, pushed: await push(SYNC_KEYS) })), sendResponse);
    default:
      return false;
  }
});
