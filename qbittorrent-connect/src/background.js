import { getConfig, applyHeaderRule } from './lib/config.js';
import { Qbt } from './lib/qbt.js';
import { parseTorrent, parseMagnet } from './lib/torrent.js';

const MENU_ID = 'qbt-add-link';
const WINDOW_SIZES = {
  normal: { width: 1100, height: 820 },
  large: { width: 1320, height: 940 },
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Ajouter à qBittorrent', contexts: ['link'] });
  });
  const cfg = await getConfig();
  await applyHeaderRule(cfg.serverUrl);
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  const cfg = await getConfig();
  await applyHeaderRule(cfg.serverUrl);
});

function notify(cfg, title, message) {
  if (!cfg.notifications) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}

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

// Mode « ajout direct » : envoi immédiat avec les réglages par défaut.
// Lève une erreur si le torrent ne peut pas être lu, pour basculer sur la fenêtre.
async function quickAdd(data, cfg) {
  const form = new FormData();
  let name;
  if (data.kind === 'magnet') {
    form.append('urls', data.url);
    name = parseMagnet(data.url).name;
  } else {
    const url = data.kind === 'download' ? (data.finalUrl || data.url) : data.url;
    const bytes = await fetchTorrentBytes(url);
    if (bytes) {
      const torrent = await parseTorrent(bytes);
      name = torrent.name;
      form.append('torrents', new Blob([bytes], { type: 'application/x-bittorrent' }), `${torrent.name}.torrent`);
    } else if (data.kind === 'url') {
      form.append('urls', url);
      name = url;
    } else {
      throw new Error('torrent illisible');
    }
  }
  if (cfg.defaultCategory) form.append('category', cfg.defaultCategory);
  if (cfg.rememberLastPath && cfg.recentPaths[0]) {
    form.append('autoTMM', 'false');
    form.append('savepath', cfg.recentPaths[0]);
  }

  await new Qbt(cfg).addTorrent(form);

  if (data.kind === 'download' && cfg.deleteLocalTorrent) {
    try { await chrome.downloads.removeFile(data.downloadId); } catch { /* déjà supprimé */ }
    try { await chrome.downloads.erase({ id: data.downloadId }); } catch { /* idem */ }
  }
  notify(cfg, 'Torrent ajouté à qBittorrent', name);
}

async function handleIncoming(data) {
  const cfg = await getConfig();
  if (cfg.addMode === 'direct' && data.kind !== 'empty') {
    try {
      await quickAdd(data, cfg);
      return;
    } catch (e) {
      // Lecture ou envoi impossible : la fenêtre d'ajout prend le relais.
      if (!/torrent illisible/.test(e.message)) notify(cfg, "Échec de l'ajout direct", e.message);
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let data = null;
  // Popup, fenêtre d'ajout ou page de l'extension ouverte dans un onglet (pas un script de contenu).
  const fromExtensionPage = sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''));
  if (msg?.type === 'magnet' && /^magnet:/i.test(msg.url || '')) {
    data = { kind: 'magnet', url: msg.url };
  } else if (msg?.type === 'open-add' && fromExtensionPage) {
    data = msg.data;
  }
  if (!data) return false;
  handleIncoming(data).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});
