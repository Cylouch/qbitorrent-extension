import { Qbt } from '../lib/qbt.js';
import { getConfig, setConfig } from '../lib/config.js';
import { parseTorrent, parseMagnet, isMagnet, formatSize } from '../lib/torrent.js';
import { icon } from '../lib/icons.js';
import { $, esc, hydrateIcons, copyText } from '../lib/ui.js';
import { initTheme, bindThemeButton } from '../lib/theme.js';
import { fileType, TYPE_ICON } from '../lib/filetypes.js';
import { resolvePath, rootOf, samePath } from '../lib/paths.js';
import { driveName, freeLevel, quickAccess } from '../lib/storage.js';
import { pickFolder } from '../ui/explorer.js';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

const PRIORITIES = [
  [0, 'Ne pas télécharger'],
  [1, 'Normale'],
  [6, 'Haute'],
  [7, 'Maximale'],
];
const NEW_CATEGORY = '\u0000new';

const st = {
  cfg: null,
  qbt: null,
  pendingKey: null,
  // Serveur
  serverReady: false,
  defaultsApplied: false,
  prefs: {},
  categories: {},
  newCategories: new Set(),
  lastCategory: '',
  tags: [],
  selectedTags: new Set(),
  manualSavePath: '',
  duplicate: false,
  space: null, // { root, free, at } : espace libre sur le disque de destination
  defaultFree: null,
  // Source
  mode: null, // 'torrent' | 'magnet' | 'url'
  torrent: null,
  bytes: null,
  filename: '',
  url: '',
  magnet: null,
  download: null,
  // Fichiers
  tree: null,
  prio: [],
  collapsed: new Set(),
  filter: '',
  busy: false,
};

const basename = (p) => (p || '').split(/[\\/]/).pop();
const chip = (ic, text, cls = '') => `<span class="chip ${cls}">${icon(ic)}${esc(text)}</span>`;

// ---------------------------------------------------------------------------
// Bandeau, statut, bouton

const BANNER_ICON = { error: 'alert', warn: 'alert', info: 'info', ok: 'checkCircle' };

function showBanner(text, kind = 'info', action = null, tag = '') {
  const banner = $('banner');
  banner.className = `banner ${kind}`;
  banner.dataset.tag = tag;
  $('bannerIcon').innerHTML = icon(BANNER_ICON[kind]);
  $('bannerText').textContent = text;
  const btn = $('bannerBtn');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.onClick;
  }
  banner.hidden = false;
}

function hideBanner(tag) {
  if (!tag || $('banner').dataset.tag === tag) $('banner').hidden = true;
}

function setStatus(text, kind = '') {
  $('status').innerHTML = text ? `${kind === 'busy' ? '<span class="spinner"></span>' : ''}<span>${esc(text)}</span>` : '';
  $('status').className = `status ${kind}`;
}

function updateAddButton() {
  $('addBtn').disabled = st.busy || !st.serverReady || !st.mode;
}

// ---------------------------------------------------------------------------
// Serveur et valeurs par défaut

async function loadServer() {
  $('serverDot').className = 'dot wait';
  try {
    const [prefs, categories, tags, version] = await Promise.all([
      st.qbt.preferences(),
      st.qbt.categories(),
      st.qbt.tags(),
      st.qbt.version().catch(() => ''),
    ]);
    st.prefs = prefs;
    st.categories = categories || {};
    st.tags = tags || [];
    st.serverReady = true;
    $('serverDot').className = 'dot ok';
    $('server').textContent = `${new URL(st.cfg.serverUrl).host}${version ? ` · ${version}` : ''}`;
    hideBanner('server');
    if (!st.defaultsApplied) applyDefaults();
    renderCategories($('category').value || undefined);
    renderTags();
    updateDest();
  } catch (e) {
    st.serverReady = false;
    $('serverDot').className = 'dot err';
    $('server').textContent = 'Hors ligne';
    showBanner(`Connexion à qBittorrent impossible : ${e.message}`, 'error', {
      label: 'Réessayer',
      onClick: () => loadServer().then(checkDuplicate),
    }, 'server');
  }
  updateAddButton();
}

function applyDefaults() {
  const p = st.prefs;
  st.defaultsApplied = true;
  setAuto(Boolean(p.auto_tmm_enabled));
  st.manualSavePath = (st.cfg.rememberLastPath && st.cfg.recentPaths[0]) || p.save_path || '';
  $('savepath').value = st.manualSavePath;
  $('useDownloadPath').checked = Boolean(p.temp_path_enabled);
  $('downloadPath').value = p.temp_path || '';
  // qBittorrent 5 : add_stopped_enabled ; qBittorrent 4 : start_paused_enabled.
  $('start').checked = !(p.add_stopped_enabled ?? p.start_paused_enabled ?? false);
  $('stopCondition').value = p.torrent_stop_condition || 'None';
  $('topQueue').checked = Boolean(p.add_to_top_of_queue);
  $('contentLayout').value = p.torrent_content_layout || 'Original';
  const def = st.cfg.defaultCategory;
  renderCategories(def && st.categories[def] ? def : '');
  $('defaultCategory').checked = Boolean(def) && $('category').value === def;
  updatePaths();
}

const isAuto = () => document.querySelector('input[name="tmm"]:checked').value === 'true';

function setAuto(auto) {
  document.querySelector(`input[name="tmm"][value="${auto}"]`).checked = true;
}

function categoryPath(name) {
  const base = st.prefs.save_path || '';
  if (!name) return base;
  return resolvePath(base, st.categories[name]?.savePath || name);
}

function updatePaths() {
  const auto = isAuto();
  const savepath = $('savepath');
  if (auto) {
    if (!savepath.disabled) st.manualSavePath = savepath.value;
    savepath.value = categoryPath(currentCategory());
  } else if (savepath.disabled) {
    savepath.value = st.manualSavePath;
  }
  savepath.disabled = auto;
  $('savepathBtn').disabled = auto;
  $('browseBtn').disabled = auto;
  $('useDownloadPath').disabled = auto;
  $('downloadPathField').hidden = auto || !$('useDownloadPath').checked;
  $('autoHint').hidden = !auto;
  updateDest();
}

const destinationPath = () => (isAuto() ? categoryPath(currentCategory()) : $('savepath').value.trim());

function updateDest() {
  const path = destinationPath();
  $('destPreview').innerHTML = path
    ? `Destination : <b>${esc(path)}</b>`
    : 'Choisis un emplacement d\'enregistrement';
  $('destPreview').title = path;
  scheduleSpace();
}

// ---------------------------------------------------------------------------
// Espace libre sur le disque de destination

// Taille des fichiers cochés (inconnue pour un magnet ou une URL).
function neededBytes() {
  if (st.mode !== 'torrent') return 0;
  return st.torrent.files.reduce((sum, f) => sum + (st.prio[f.index] > 0 ? f.size : 0), 0);
}

let spaceTimer;
let spaceToken = 0;

function scheduleSpace() {
  clearTimeout(spaceTimer);
  spaceTimer = setTimeout(refreshSpace, 350);
}

async function refreshSpace() {
  const path = destinationPath();
  if (!st.serverReady || !path) {
    st.space = null;
    renderSpace();
    return;
  }
  const root = rootOf(path);
  if (st.space && samePath(st.space.root, root) && Date.now() - st.space.at < 30000) {
    renderSpace();
    return;
  }
  const token = ++spaceToken;
  let free = await st.qbt.freeSpaceAt(path);
  // Avant qBittorrent 5.3 : seul l'espace libre de l'emplacement par défaut est connu.
  if (free == null && samePath(rootOf(st.prefs.save_path), root)) {
    st.defaultFree ??= st.qbt.maindata(0).then((r) => r.server_state?.free_space_on_disk ?? null, () => null);
    free = await st.defaultFree;
  }
  if (token !== spaceToken) return;
  st.space = { root, free, at: Date.now() };
  renderSpace();
}

function renderSpace() {
  const el = $('spaceHint');
  const s = st.space;
  if (!s || s.free == null) {
    el.hidden = true;
    return;
  }
  const need = neededBytes();
  const drive = esc(driveName(s.root, st.cfg.driveNames));
  el.className = `space-hint ${freeLevel(s.free, need)}`;
  el.innerHTML = need > s.free
    ? `${icon('alert')}<span>Pas assez de place sur ${drive} : <b>${formatSize(s.free)}</b> libres, il faut ${formatSize(need)}.</span>`
    : `${icon('hardDrive')}<span>${drive} · <b>${formatSize(s.free)}</b> libres${need ? ` · il en restera ${formatSize(s.free - need)}` : ''}</span>`;
  el.hidden = false;
}

async function browse(inputId) {
  const input = $(inputId);
  const isSave = inputId === 'savepath';
  const path = await pickFolder({
    qbt: st.qbt,
    cfg: st.cfg,
    prefs: st.prefs,
    quick: quickAccess({ prefs: st.prefs, categories: st.categories, recentPaths: st.cfg.recentPaths }),
    initial: input.value.trim() || st.prefs.save_path || '',
    need: isSave ? neededBytes() : 0,
    title: isSave ? "Choisir l'emplacement" : 'Dossier des téléchargements incomplets',
  });
  if (!path) return;
  input.value = path;
  if (isSave) st.manualSavePath = path;
  updateDest();
}

// ---------------------------------------------------------------------------
// Catégories, étiquettes, emplacements récents

function currentCategory() {
  const v = $('category').value;
  return v === NEW_CATEGORY ? '' : v;
}

function renderCategories(selected) {
  const sel = $('category');
  sel.innerHTML = '';
  sel.append(new Option('Aucune catégorie', ''));
  for (const name of Object.keys(st.categories).sort(collator.compare)) sel.append(new Option(name, name));
  for (const name of st.newCategories) sel.append(new Option(`${name} (nouvelle)`, name));
  sel.append(new Option('＋ Nouvelle catégorie…', NEW_CATEGORY));
  sel.value = selected ?? st.lastCategory ?? '';
  st.lastCategory = sel.value;
}

function onCategoryChange() {
  const sel = $('category');
  if (sel.value === NEW_CATEGORY) {
    const name = (prompt('Nom de la nouvelle catégorie :') || '').trim();
    if (name && !st.categories[name]) st.newCategories.add(name);
    renderCategories(name || st.lastCategory);
  }
  st.lastCategory = sel.value;
  updatePaths();
}

function renderTags() {
  $('tagChips').innerHTML = [...st.selectedTags].sort(collator.compare).map((t) => `
    <span class="chip accent tag-chip">${icon('tag')}${esc(t)}<button type="button" class="chip-x" data-remove-tag="${esc(t)}" title="Retirer">${icon('x')}</button></span>
  `).join('');
  const all = [...new Set([...st.tags, ...st.selectedTags])].sort(collator.compare);
  $('tagsList').innerHTML = all.length
    ? all.map((t) => {
      const on = st.selectedTags.has(t);
      return `<li class="menu-item${on ? ' selected' : ''}" data-tag="${esc(t)}"><span class="check-slot">${on ? icon('check') : ''}</span><span>${esc(t)}</span></li>`;
    }).join('')
    : '<li class="menu-sep">Aucune étiquette sur le serveur</li>';
}

function toggleTag(tag) {
  if (st.selectedTags.has(tag)) st.selectedTags.delete(tag);
  else st.selectedTags.add(tag);
  renderTags();
}

function renderSavepathMenu() {
  const groups = [
    ['Récents', 'history', st.cfg.recentPaths],
    ['Par défaut', 'hardDrive', [st.prefs.save_path].filter(Boolean)],
    ['Catégories', 'folder', Object.keys(st.categories).sort(collator.compare).map((name) => categoryPath(name))],
  ];
  const seen = new Set();
  let html = '';
  for (const [title, ic, paths] of groups) {
    const items = paths.filter((p) => p && !seen.has(p));
    if (!items.length) continue;
    items.forEach((p) => seen.add(p));
    html += `<li class="menu-sep">${esc(title)}</li>`;
    html += items.map((p) => `<li class="menu-item" data-path="${esc(p)}" title="${esc(p)}">${icon(ic)}<span>${esc(p)}</span></li>`).join('');
  }
  $('savepathMenu').innerHTML = html || '<li class="menu-sep">Aucun emplacement enregistré</li>';
}

function closeMenus(except) {
  document.querySelectorAll('.menu').forEach((m) => { if (m !== except) m.hidden = true; });
}

function toggleMenu(menu) {
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
}

// ---------------------------------------------------------------------------
// Chargement de la source

function fileUrl(path) {
  const parts = path.replace(/\\/g, '/').split('/');
  const encoded = parts
    .map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s)))
    .join('/');
  return encoded.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

// fetch() ne gère pas file:// ; XMLHttpRequest oui, si l'accès aux URL de
// fichier est autorisé pour l'extension.
function readLocalFile(path) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', fileUrl(path));
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      const bytes = new Uint8Array(xhr.response || new ArrayBuffer(0));
      if (bytes[0] === 0x64) resolve(bytes);
      else reject(new Error('fichier vide ou illisible'));
    };
    xhr.onerror = () => reject(new Error('accès refusé'));
    xhr.send();
  });
}

async function fetchTorrent(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] !== 0x64) throw new Error("la réponse n'est pas un fichier .torrent (page de connexion ?)");
  return bytes;
}

async function readDownloaded(item) {
  const errors = [];
  if (item.filename && await chrome.extension.isAllowedFileSchemeAccess()) {
    try {
      return await readLocalFile(item.filename);
    } catch (e) {
      errors.push(`lecture du fichier : ${e.message}`);
    }
  }
  const url = item.finalUrl || item.url;
  if (/^https?:/i.test(url)) {
    try {
      return await fetchTorrent(url);
    } catch (e) {
      errors.push(`nouveau téléchargement : ${e.message}`);
    }
  }
  throw new Error(errors.join(' ; ') || 'source inaccessible');
}

function filenameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    return /\.torrent$/i.test(name) ? name : '';
  } catch {
    return '';
  }
}

async function loadSource(src) {
  switch (src.kind) {
    case 'download': {
      st.download = src;
      st.url = src.finalUrl || src.url;
      try {
        await useTorrentBytes(await readDownloaded(src), basename(src.filename));
      } catch (e) {
        const access = await chrome.extension.isAllowedFileSchemeAccess();
        showPicker(
          `Impossible de lire le torrent automatiquement (${e.message}).\n`
          + `Il a été enregistré ici : ${src.filename}`
          + (access ? '' : "\nAstuce : active « Autoriser l'accès aux URL de fichier » pour l'extension, la lecture sera alors toujours possible."),
          /^https?:/i.test(st.url),
        );
      }
      break;
    }
    case 'url': {
      st.url = src.url;
      try {
        await useTorrentBytes(await fetchTorrent(src.url), filenameFromUrl(src.url));
      } catch (e) {
        useUrlOnly(src.url);
        showBanner(`L'extension n'a pas pu lire ce torrent (${e.message}). qBittorrent le téléchargera lui-même.`, 'warn');
      }
      break;
    }
    case 'magnet':
      useMagnet(src.url);
      break;
    default:
      showPicker('', false);
  }
}

async function useTorrentBytes(bytes, filename) {
  const torrent = await parseTorrent(bytes);
  st.mode = 'torrent';
  st.torrent = torrent;
  st.magnet = null;
  st.bytes = bytes;
  st.filename = filename || `${torrent.name}.torrent`;
  st.prio = torrent.files.map(() => 1);
  st.tree = buildTree(torrent.files);
  st.collapsed.clear();
  showMain();
}

function useMagnet(uri) {
  st.mode = 'magnet';
  st.magnet = parseMagnet(uri);
  st.torrent = null;
  showMain();
}

function useUrlOnly(url) {
  st.mode = 'url';
  st.url = url;
  st.torrent = null;
  st.magnet = null;
  showMain();
}

function showPicker(message, canSendUrl) {
  $('pickerMsg').hidden = !message;
  $('pickerMsgText').textContent = message;
  $('sendUrlRow').hidden = !canSendUrl;
  $('picker').hidden = false;
  $('hero').hidden = true;
  $('main').hidden = true;
  $('actions').hidden = true;
}

function showMain() {
  $('picker').hidden = true;
  $('main').hidden = false;
  $('actions').hidden = false;
  st.duplicate = false;
  renderHero();
  renderInfo();
  renderFiles();
  updateAddButton();
  checkDuplicate();
}

function displayName() {
  if (st.torrent) return st.torrent.name;
  if (st.mode === 'magnet') return st.magnet.name;
  return filenameFromUrl(st.url) || st.url;
}

function dominantType(files) {
  const sizes = {};
  for (const f of files) {
    const t = fileType(f.path);
    sizes[t] = (sizes[t] || 0) + f.size;
  }
  return Object.entries(sizes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'file';
}

function renderHero() {
  const t = st.torrent;
  const m = st.magnet;
  const name = displayName();
  $('title').textContent = name;
  $('title').title = name;
  document.title = `${name} — Ajouter`;

  const heroIcon = t ? TYPE_ICON[dominantType(t.files)] : st.mode === 'magnet' ? 'magnet' : 'globe';
  $('heroIcon').innerHTML = icon(heroIcon);

  const chips = [];
  if (t) {
    chips.push(chip('hardDrive', formatSize(t.totalSize)));
    chips.push(chip('layers', `${t.files.length} fichier${t.files.length > 1 ? 's' : ''}`));
    if (t.creationDate) {
      chips.push(chip('calendar', new Date(t.creationDate * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })));
    }
    if (t.trackers.length) chips.push(chip('radio', `${t.trackers.length} tracker${t.trackers.length > 1 ? 's' : ''}`));
    if (t.isPrivate) chips.push(chip('lock', 'Privé', 'warn'));
    if (t.hashV2) chips.push(chip('hash', t.hashV1 ? 'Hybride v1 + v2' : 'BitTorrent v2'));
  } else if (st.mode === 'magnet') {
    chips.push(chip('magnet', 'Lien magnet', 'accent'));
    if (m.trackers.length) chips.push(chip('radio', `${m.trackers.length} tracker${m.trackers.length > 1 ? 's' : ''}`));
  } else {
    chips.push(chip('globe', 'Téléchargé par le serveur', 'accent'));
  }
  if (st.duplicate) chips.push(chip('alert', 'Déjà dans qBittorrent', 'err'));
  $('heroChips').innerHTML = chips.join('');
  $('hero').hidden = false;
  $('rename').placeholder = name;
}

function renderInfo() {
  const t = st.torrent;
  const m = st.magnet;
  const trackers = t?.trackers || m?.trackers || [];
  const source = st.download ? st.download.filename : st.mode === 'magnet' ? m.uri : st.url || st.filename;
  const rows = [
    ['hash', 'Hash v1', t ? t.hashV1 : m?.hashV1, true],
    ['hash', 'Hash v2', t ? t.hashV2 : m?.hashV2, true],
  ];
  if (t) {
    rows.push(['calendar', 'Créé le', t.creationDate ? new Date(t.creationDate * 1000).toLocaleString('fr-FR') : null]);
    rows.push(['user', 'Créé par', t.createdBy || null]);
  }
  rows.push(['radio', 'Trackers', trackers.length
    ? trackers.slice(0, 3).join('\n') + (trackers.length > 3 ? `\n+ ${trackers.length - 3} autre(s)` : '')
    : null]);
  rows.push(['link', 'Source', source || null, Boolean(source)]);

  $('infoList').innerHTML = rows.map(([ic, label, value, copy]) => `
    <dt>${icon(ic)}${esc(label)}</dt>
    <dd>${value
    ? `<span class="val${copy && ic === 'hash' ? ' mono' : ''}">${esc(value)}</span>${copy ? `<button type="button" class="btn btn-ghost btn-xs" data-copy="${esc(value)}" title="Copier">${icon('copy')}</button>` : ''}`
    : '<span class="faint">N/D</span>'}</dd>
  `).join('');
  $('iComment').value = t?.comment || '';
  $('commentField').hidden = !t?.comment;
}

// ---------------------------------------------------------------------------
// Arborescence des fichiers

function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push({ ...f, name: parts.at(-1), type: fileType(f.path) });
  }
  const finish = (node) => {
    node.indexes = node.files.map((f) => f.index);
    node.size = node.files.reduce((s, f) => s + f.size, 0);
    for (const d of node.dirs.values()) {
      finish(d);
      node.indexes.push(...d.indexes);
      node.size += d.size;
    }
    node.files.sort((a, b) => collator.compare(a.name, b.name));
  };
  finish(root);
  return root;
}

function allDirPaths(node, out = []) {
  for (const d of node.dirs.values()) {
    out.push(d.path);
    allDirPaths(d, out);
  }
  return out;
}

function prioSelect(value) {
  const mixed = value == null;
  return `<select class="input prio p${mixed ? 'mixed' : value}" data-prio>${mixed ? '<option value="" selected>Mixte</option>' : ''}${
    PRIORITIES.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('')
  }</select>`;
}

function emptyState(ic, title, text) {
  return `<span class="big-ico">${icon(ic)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p>`;
}

function renderFiles() {
  const body = $('filesBody');
  const empty = $('filesEmpty');
  const isTorrent = st.mode === 'torrent';
  ['selAll', 'selNone', 'filter', 'checkAll', 'expandBtn'].forEach((id) => { $(id).disabled = !isTorrent; });

  if (!isTorrent) {
    body.innerHTML = '';
    $('filesCount').textContent = '';
    $('filesSub').textContent = 'Liste indisponible pour le moment';
    empty.hidden = false;
    empty.innerHTML = st.mode === 'magnet'
      ? emptyState('magnet', 'Lien magnet', "La liste des fichiers sera connue quand qBittorrent aura récupéré les métadonnées. Choisis la condition d'arrêt « Métadonnées reçues » pour sélectionner les fichiers ensuite dans l'interface web.")
      : emptyState('globe', 'Téléchargé par le serveur', "qBittorrent récupérera lui-même le fichier .torrent : la liste des fichiers n'est pas disponible ici.");
    $('filesSummary').textContent = '';
    $('meterFill').style.width = '0';
    return;
  }

  const files = st.torrent.files;
  $('filesCount').textContent = files.length;
  $('filesSub').textContent = `${formatSize(st.torrent.totalSize)} au total`;
  const filter = st.filter.toLowerCase();
  const matches = (i) => !filter || files[i].path.toLowerCase().includes(filter);
  const rows = [];

  const walk = (node, depth) => {
    const pad = depth * 20;
    for (const dir of [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name))) {
      if (!dir.indexes.some(matches)) continue;
      const selected = dir.indexes.filter((i) => st.prio[i] > 0).length;
      const values = new Set(dir.indexes.map((i) => st.prio[i]));
      const collapsed = !filter && st.collapsed.has(dir.path);
      rows.push(`<tr class="dir${selected ? '' : ' off'}" data-dir="${esc(dir.path)}">
        <td class="c-check"><input type="checkbox" ${selected === dir.indexes.length ? 'checked' : ''} ${selected && selected < dir.indexes.length ? 'data-mixed' : ''}></td>
        <td class="name"><div class="cell" style="padding-left:${pad}px">
          <button type="button" class="twisty${collapsed ? ' collapsed' : ''}" data-toggle>${icon('chevronDown')}</button>
          <span class="ftype folder">${icon(collapsed ? 'folder' : 'folderOpen')}</span>
          <span class="label" title="${esc(dir.path)}">${esc(dir.name)}</span>
          <span class="sub-count">${dir.indexes.length}</span>
        </div></td>
        <td class="c-size">${formatSize(dir.size)}</td>
        <td class="c-prio">${prioSelect(values.size === 1 ? [...values][0] : null)}</td>
      </tr>`);
      if (!collapsed) walk(dir, depth + 1);
    }
    for (const f of node.files) {
      if (!matches(f.index)) continue;
      const p = st.prio[f.index];
      rows.push(`<tr class="file${p > 0 ? '' : ' off'}" data-index="${f.index}">
        <td class="c-check"><input type="checkbox" ${p > 0 ? 'checked' : ''}></td>
        <td class="name"><div class="cell" style="padding-left:${pad}px">
          <span class="twisty-spacer"></span>
          <span class="ftype ${f.type}">${icon(TYPE_ICON[f.type])}</span>
          <span class="label" title="${esc(f.path)}">${esc(f.name)}</span>
        </div></td>
        <td class="c-size">${formatSize(f.size)}</td>
        <td class="c-prio">${prioSelect(p)}</td>
      </tr>`);
    }
  };
  walk(st.tree, 0);

  body.innerHTML = rows.join('');
  body.querySelectorAll('input[data-mixed]').forEach((el) => { el.indeterminate = true; });
  empty.hidden = rows.length > 0;
  if (!rows.length) empty.innerHTML = emptyState('search', 'Aucun résultat', 'Aucun fichier ne correspond au filtre.');

  const anyCollapsed = st.collapsed.size > 0;
  $('expandBtn').innerHTML = icon(anyCollapsed ? 'chevronsUpDown' : 'chevronsDownUp');
  $('expandBtn').title = anyCollapsed ? 'Tout déplier' : 'Tout replier';
  updateSummary();
}

function updateSummary() {
  const files = st.torrent.files;
  const selected = files.filter((f) => st.prio[f.index] > 0);
  const size = selected.reduce((s, f) => s + f.size, 0);
  const total = st.torrent.totalSize || 1;
  $('meterFill').style.width = `${(size / total) * 100}%`;
  $('filesSummary').innerHTML = `<b>${selected.length}</b> / ${files.length} fichier${files.length > 1 ? 's' : ''} · <b>${formatSize(size)}</b> sur ${formatSize(st.torrent.totalSize)}`;
  const all = $('checkAll');
  all.checked = selected.length === files.length;
  all.indeterminate = selected.length > 0 && selected.length < files.length;
  renderSpace();
}

function findDir(node, path) {
  for (const d of node.dirs.values()) {
    if (d.path === path) return d;
    if (path.startsWith(`${d.path}/`)) return findDir(d, path);
  }
  return null;
}

function indexesOfRow(tr) {
  if (tr.dataset.index != null) return [Number(tr.dataset.index)];
  return findDir(st.tree, tr.dataset.dir)?.indexes || [];
}

function setPriority(indexes, value) {
  for (const i of indexes) st.prio[i] = value;
  renderFiles();
}

function onFilesChange(e) {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const indexes = indexesOfRow(tr);
  if (e.target.matches('input[type=checkbox]')) {
    if (e.target.checked) indexes.forEach((i) => { if (st.prio[i] === 0) st.prio[i] = 1; });
    else indexes.forEach((i) => { st.prio[i] = 0; });
    renderFiles();
  } else if (e.target.matches('select[data-prio]') && e.target.value !== '') {
    setPriority(indexes, Number(e.target.value));
  }
}

function onFilesClick(e) {
  const toggle = e.target.closest('[data-toggle]');
  if (!toggle) return;
  const path = toggle.closest('tr').dataset.dir;
  if (st.collapsed.has(path)) st.collapsed.delete(path);
  else st.collapsed.add(path);
  renderFiles();
}

// ---------------------------------------------------------------------------
// Doublons

async function checkDuplicate() {
  const id = st.torrent?.id || st.magnet?.id;
  if (!id || !st.serverReady) return;
  try {
    const found = await st.qbt.torrents({ hashes: id });
    if (found.length) {
      st.duplicate = true;
      renderHero();
      showBanner(`Ce torrent est déjà présent dans qBittorrent (« ${found[0].name} »).`, 'warn', null, 'duplicate');
    }
  } catch { /* simple vérification */ }
}

// ---------------------------------------------------------------------------
// Envoi

async function waitForTorrent(hash, fileCount) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const files = await st.qbt.files(hash);
      if (files.length >= fileCount) return;
    } catch (e) {
      if (e.status !== 404 && e.status !== 409) throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("le torrent n'est pas apparu dans qBittorrent à temps pour appliquer les priorités");
}

const ADD_BTN_HTML = () => `${icon('download')}<span>Ajouter</span><kbd>Ctrl ↵</kbd>`;

async function submit() {
  if (st.busy || !st.mode || $('addBtn').disabled) return;
  const auto = isAuto();
  const savepath = $('savepath').value.trim();
  const category = currentCategory();
  const wantStart = $('start').checked;
  const customPrio = st.mode === 'torrent' && st.prio.some((p) => p !== 1);

  if (!auto && !savepath) {
    setStatus("Indique un emplacement d'enregistrement.", 'error');
    $('savepath').focus();
    return;
  }
  if (customPrio && st.prio.every((p) => p === 0)) {
    setStatus('Aucun fichier sélectionné.', 'error');
    return;
  }

  st.busy = true;
  updateAddButton();
  $('addBtn').innerHTML = '<span class="spinner"></span><span>Envoi…</span>';
  setStatus('');

  try {
    if (category && !st.categories[category]) {
      await st.qbt.createCategory(category);
      st.categories[category] = { name: category, savePath: '' };
    }
    const newTags = [...st.selectedTags].filter((t) => !st.tags.includes(t));
    if (newTags.length) await st.qbt.createTags(newTags);

    const form = new FormData();
    if (st.mode === 'torrent') {
      form.append('torrents', new Blob([st.bytes], { type: 'application/x-bittorrent' }), st.filename);
    } else {
      form.append('urls', st.mode === 'magnet' ? st.magnet.uri : st.url);
    }
    form.append('autoTMM', String(auto));
    if (!auto) {
      form.append('savepath', savepath);
      const useDl = $('useDownloadPath').checked && $('downloadPath').value.trim();
      form.append('useDownloadPath', String(Boolean(useDl)));
      if (useDl) form.append('downloadPath', $('downloadPath').value.trim());
    }
    if (category) form.append('category', category);
    if (st.selectedTags.size) form.append('tags', [...st.selectedTags].join(','));
    const rename = $('rename').value.trim();
    if (rename) form.append('rename', rename);

    // Si des fichiers sont désélectionnés, on ajoute le torrent arrêté le temps
    // d'appliquer les priorités, pour ne rien télécharger de non voulu.
    const stopped = !wantStart || customPrio;
    form.append('stopped', String(stopped)); // qBittorrent 5
    form.append('paused', String(stopped)); // qBittorrent 4
    form.append('stopCondition', $('stopCondition').value);
    form.append('addToTopOfQueue', String($('topQueue').checked));
    form.append('skip_checking', String($('skipChecking').checked));
    form.append('sequentialDownload', String($('sequential').checked));
    form.append('firstLastPiecePrio', String($('firstLast').checked));
    form.append('contentLayout', $('contentLayout').value);
    const dl = Number($('dlLimit').value);
    const up = Number($('upLimit').value);
    if (dl > 0) form.append('dlLimit', String(Math.round(dl * 1024)));
    if (up > 0) form.append('upLimit', String(Math.round(up * 1024)));

    await st.qbt.addTorrent(form);

    if (customPrio) {
      $('addBtn').innerHTML = '<span class="spinner"></span><span>Priorités…</span>';
      const hash = st.torrent.id;
      await waitForTorrent(hash, st.torrent.files.length);
      const groups = new Map();
      st.prio.forEach((p, i) => {
        if (p === 1) return;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(i);
      });
      for (const [priority, ids] of groups) await st.qbt.filePrio(hash, ids, priority);
      if (wantStart) await st.qbt.start(hash);
    }

    await afterSuccess(auto ? '' : savepath, category);
  } catch (e) {
    st.busy = false;
    $('addBtn').innerHTML = ADD_BTN_HTML();
    updateAddButton();
    setStatus(`Échec : ${e.message}`, 'error');
  }
}

async function afterSuccess(savepath, category) {
  const cfg = await getConfig();
  const patch = {};
  if (savepath) patch.recentPaths = [savepath, ...cfg.recentPaths.filter((p) => p !== savepath)].slice(0, 10);
  if ($('defaultCategory').checked) patch.defaultCategory = category;
  else if (cfg.defaultCategory && cfg.defaultCategory === category) patch.defaultCategory = '';
  if (Object.keys(patch).length) await setConfig(patch);

  if (st.download && cfg.deleteLocalTorrent) {
    try { await chrome.downloads.removeFile(st.download.downloadId); } catch { /* déjà supprimé */ }
    try { await chrome.downloads.erase({ id: st.download.downloadId }); } catch { /* idem */ }
  }
  if (st.pendingKey) await chrome.storage.session.remove(st.pendingKey);

  const name = $('rename').value.trim() || displayName();
  if (cfg.notifications && cfg.closeAfterAdd) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Torrent ajouté à qBittorrent',
      message: name,
    });
  }

  $('successName').textContent = name;
  $('successActions').hidden = cfg.closeAfterAdd;
  $('successHint').textContent = cfg.closeAfterAdd ? 'Cette fenêtre va se fermer…' : '';
  $('success').hidden = false;
  if (cfg.closeAfterAdd) setTimeout(() => window.close(), 1400);
  else $('successClose').focus();
}

async function cancel() {
  if (st.pendingKey) await chrome.storage.session.remove(st.pendingKey);
  window.close();
}

// ---------------------------------------------------------------------------
// Événements

function wireUi() {
  bindThemeButton($('themeBtn'));
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  document.querySelectorAll('input[name="tmm"]').forEach((r) => r.addEventListener('change', updatePaths));
  $('category').addEventListener('change', onCategoryChange);
  $('useDownloadPath').addEventListener('change', updatePaths);
  $('savepath').addEventListener('input', (e) => { st.manualSavePath = e.target.value; updateDest(); });

  $('browseBtn').addEventListener('click', () => browse('savepath'));
  $('browseDlBtn').addEventListener('click', () => browse('downloadPath'));
  $('savepathBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    renderSavepathMenu();
    toggleMenu($('savepathMenu'));
  });
  $('savepathMenu').addEventListener('click', (e) => {
    const li = e.target.closest('[data-path]');
    if (!li) return;
    $('savepath').value = li.dataset.path;
    st.manualSavePath = li.dataset.path;
    closeMenus();
    updateDest();
  });

  $('tagsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu($('tagsMenu'));
    if (!$('tagsMenu').hidden) $('newTag').focus();
  });
  $('tagsMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    const li = e.target.closest('[data-tag]');
    if (li) toggleTag(li.dataset.tag);
  });
  $('tagChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-tag]');
    if (btn) toggleTag(btn.dataset.removeTag);
  });
  $('newTagForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const tag = $('newTag').value.trim().replace(/,/g, '');
    if (!tag) return;
    st.selectedTags.add(tag);
    $('newTag').value = '';
    renderTags();
  });
  document.addEventListener('click', () => closeMenus());

  $('infoList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) copyText(btn.dataset.copy);
  });

  $('filesBody').addEventListener('change', onFilesChange);
  $('filesBody').addEventListener('click', onFilesClick);
  $('checkAll').addEventListener('change', (e) => setPriority(st.prio.map((_, i) => i), e.target.checked ? 1 : 0));
  $('selAll').addEventListener('click', () => setPriority(st.prio.map((_, i) => i).filter((i) => st.prio[i] === 0), 1));
  $('selNone').addEventListener('click', () => setPriority(st.prio.map((_, i) => i), 0));
  $('expandBtn').addEventListener('click', () => {
    if (st.collapsed.size) st.collapsed.clear();
    else allDirPaths(st.tree).forEach((p) => st.collapsed.add(p));
    renderFiles();
  });
  $('filter').addEventListener('input', (e) => { st.filter = e.target.value.trim(); renderFiles(); });

  $('addBtn').addEventListener('click', submit);
  $('cancelBtn').addEventListener('click', cancel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = [...document.querySelectorAll('.menu')].some((m) => !m.hidden);
      if (open) closeMenus();
      else if (!$('success').hidden) window.close();
      else cancel();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      submit();
    }
  });

  $('successClose').addEventListener('click', () => window.close());
  $('successAnother').addEventListener('click', () => { location.href = 'add.html'; });
  $('successWebui').addEventListener('click', () => chrome.tabs.create({ url: `${st.cfg.serverUrl}/` }));

  // Sélection manuelle d'une source
  const loadFile = async (file) => {
    if (!file) return;
    try {
      st.download = null;
      await useTorrentBytes(new Uint8Array(await file.arrayBuffer()), file.name);
      hideBanner();
    } catch (err) {
      $('pickerMsg').hidden = false;
      $('pickerMsgText').textContent = `Fichier refusé : ${err.message}`;
    }
  };
  $('fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
  const zone = $('dropzone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  });
  $('linkForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const link = $('linkInput').value.trim();
    if (isMagnet(link)) useMagnet(link);
    else if (/^https?:\/\//i.test(link)) await loadSource({ kind: 'url', url: link });
    else {
      $('pickerMsg').hidden = false;
      $('pickerMsgText').textContent = 'Colle un lien magnet ou une adresse http(s) vers un fichier .torrent.';
    }
  });
  $('sendUrlBtn').addEventListener('click', () => useUrlOnly(st.url));
}

async function init() {
  hydrateIcons();
  await initTheme();
  wireUi();
  st.cfg = await getConfig();
  if (!st.cfg.serverUrl) {
    showPicker('', false);
    $('serverDot').className = 'dot err';
    $('server').textContent = 'Non configuré';
    showBanner("Aucun serveur qBittorrent n'est configuré.", 'error', {
      label: 'Ouvrir les paramètres',
      onClick: () => chrome.runtime.openOptionsPage(),
    });
    return;
  }
  $('server').textContent = new URL(st.cfg.serverUrl).host;
  st.qbt = new Qbt(st.cfg);

  let pending = { kind: 'empty' };
  const id = new URLSearchParams(location.search).get('id');
  if (id) {
    st.pendingKey = `pending:${id}`;
    const stored = await chrome.storage.session.get(st.pendingKey);
    if (stored[st.pendingKey]) pending = stored[st.pendingKey];
  }

  const server = loadServer();
  await loadSource(pending);
  await server;
  checkDuplicate();
}

init();
