// Disques du serveur : lecteurs Windows, partages réseau, points de montage Unix.
//
// qBittorrent ne donne pas la taille totale d'un disque. On affiche l'espace
// libre (pour chaque disque à partir de qBittorrent 5.3, sinon seulement celui
// de l'emplacement par défaut) et la place prise par les torrents.
import { rootOf, pathKey, isWindowsPath, isInside, resolvePath, baseName, samePath } from './paths.js';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CACHE_KEY = 'drivesCache';
const CACHE_TTL = 10 * 60 * 1000;
const GIB = 1024 ** 3;

// Chemins connus de qBittorrent : emplacement par défaut, catégories, torrents.
export function knownPaths({ prefs = {}, categories = {}, torrents = [] }) {
  const base = prefs.save_path || '';
  const out = [base];
  if (prefs.temp_path_enabled) out.push(prefs.temp_path);
  for (const [name, c] of Object.entries(categories)) out.push(resolvePath(base, c?.savePath || name));
  for (const t of torrents) out.push(t.save_path, t.content_path, t.download_path);
  return out.filter(Boolean);
}

// Lettres de lecteur présentes sur un serveur Windows. null si la version de
// qBittorrent ne permet pas de parcourir les dossiers.
async function probeLetters(qbt) {
  const results = await Promise.all([...LETTERS].map(async (l) => {
    try {
      return (await qbt.dirExists(`${l}:\\`)) ? `${l}:\\` : null;
    } catch {
      return null;
    }
  }));
  return qbt.noBrowse ? null : results.filter(Boolean);
}

async function cachedLetters(qbt, serverUrl, refresh) {
  if (!refresh) {
    const cache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
    if (cache?.server === serverUrl && Date.now() - cache.at < CACHE_TTL) return cache.roots;
  }
  const roots = await probeLetters(qbt);
  if (roots) await chrome.storage.local.set({ [CACHE_KEY]: { server: serverUrl, at: Date.now(), roots } });
  return roots;
}

const kindOf = (root) => (root.startsWith('\\\\') ? 'network' : /^[A-Z]:\\$/.test(root) ? 'drive' : 'mount');

// Lecteurs d'abord (A → Z), puis partages réseau, puis Unix.
const ORDER = { drive: 0, network: 1, mount: 2 };
const byRoot = (a, b) => ORDER[a.kind] - ORDER[b.kind] || collator.compare(a.root, b.root);

// [{ root, kind, missing }] : `missing` = connu de qBittorrent mais introuvable
// (disque débranché, partage hors ligne).
export async function findDrives(qbt, { serverUrl, hints = [], refresh = false } = {}) {
  const roots = new Map();
  for (const r of hints.map(rootOf).filter(Boolean)) roots.set(pathKey(r), r);
  const windows = !roots.size || [...roots.values()].some(isWindowsPath);

  const probed = windows ? await cachedLetters(qbt, serverUrl, refresh) : null;
  const present = new Set((probed || []).map(pathKey));
  for (const r of probed || []) roots.set(pathKey(r), r);
  if (!windows) roots.set('/', '/');

  const drives = await Promise.all([...roots.values()].map(async (root) => {
    let missing = false;
    if (!present.has(pathKey(root)) && !qbt.noBrowse) {
      missing = !(await qbt.dirExists(root).catch(() => true));
    }
    return { root, kind: kindOf(root), missing };
  }));
  return drives.sort(byRoot);
}

// Place prise par les torrents, par disque : Map(clé → { count, size, done, remaining }).
export function torrentUsage(torrents) {
  const map = new Map();
  for (const t of torrents) {
    const root = rootOf(t.content_path || t.save_path);
    if (!root) continue;
    const key = pathKey(root);
    const u = map.get(key) || { count: 0, size: 0, done: 0, remaining: 0 };
    const size = t.size || 0; // fichiers sélectionnés
    const done = Math.min(size, t.completed ?? size * (t.progress || 0));
    u.count++;
    u.size += size;
    u.done += done;
    u.remaining += Math.max(0, size - done);
    map.set(key, u);
  }
  return map;
}

// Tout pour la vue des disques. `torrents`, `categories` et `defaultFree`
// évitent un appel à sync/maindata quand l'appelant les a déjà.
export async function loadStorage(qbt, { serverUrl, prefs, torrents, categories, defaultFree, refresh = false } = {}) {
  const needMain = !torrents;
  const [p, main] = await Promise.all([
    prefs || qbt.preferences().catch(() => ({})),
    needMain ? qbt.maindata(0).catch(() => ({})) : null,
  ]);
  const list = needMain ? Object.values(main.torrents || {}) : torrents;
  const cats = categories || main?.categories || {};
  const fallbackFree = defaultFree ?? main?.server_state?.free_space_on_disk ?? null;

  const drives = await findDrives(qbt, { serverUrl, hints: knownPaths({ prefs: p, categories: cats, torrents: list }), refresh });
  const usage = torrentUsage(list);
  await Promise.all(drives.map(async (d) => {
    d.isDefault = isInside(p.save_path, d.root);
    d.usage = usage.get(pathKey(d.root)) || null;
    d.free = d.missing ? null : await qbt.freeSpaceAt(d.root);
    // Avant qBittorrent 5.3 : seul l'espace libre de l'emplacement par défaut est connu.
    if (d.free == null && d.isDefault && fallbackFree != null) d.free = fallbackFree;
  }));
  return {
    drives,
    prefs: p,
    categories: cats,
    browse: !qbt.noBrowse,
    freeApi: !qbt.noFreeSpace,
    version: qbt.noBrowse || qbt.noFreeSpace ? await qbt.version().catch(() => '') : '',
  };
}

export function driveName(root, names = {}) {
  const custom = names?.[root];
  const letter = /^([A-Z]):\\$/.exec(root)?.[1];
  if (letter) return custom ? `${custom} (${letter}:)` : `Disque (${letter}:)`;
  if (custom) return custom;
  const unc = /^\\\\([^\\]+)\\(.+)$/.exec(root);
  if (unc) return `${unc[2]} (\\\\${unc[1]})`;
  return root === '/' ? 'Racine du serveur' : baseName(root);
}

// Niveau d'alerte : place insuffisante pour finir les téléchargements, ou peu d'espace.
export function freeLevel(free, need = 0) {
  if (free == null) return '';
  if (need > free || free < 20 * GIB) return 'err';
  if (free < 100 * GIB) return 'warn';
  return 'ok';
}

export function driveFor(drives, path) {
  const root = rootOf(path);
  return (drives || []).find((d) => samePath(d.root, root)) || null;
}

// Raccourcis de l'explorateur : [{ group, label, path, icon }].
export function quickAccess({ prefs = {}, categories = {}, recentPaths = [] }) {
  const base = prefs.save_path || '';
  const items = [];
  if (base) items.push({ group: 'Accès rapide', label: 'Emplacement par défaut', path: base, icon: 'download' });
  if (prefs.temp_path_enabled && prefs.temp_path) {
    items.push({ group: 'Accès rapide', label: 'Téléchargements incomplets', path: prefs.temp_path, icon: 'clock' });
  }
  for (const name of Object.keys(categories).sort(collator.compare)) {
    items.push({ group: 'Catégories', label: name, path: resolvePath(base, categories[name]?.savePath || name), icon: 'tag' });
  }
  for (const p of recentPaths) items.push({ group: 'Récents', label: baseName(p) || p, path: p, icon: 'history' });
  return items.filter((item, i) => item.path && items.findIndex((o) => samePath(o.path, item.path)) === i);
}
