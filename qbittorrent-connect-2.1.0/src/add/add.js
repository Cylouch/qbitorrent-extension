import { createClient } from '../lib/clients/index.js';
import { baseName, parentPath } from '../lib/clients/base.js';
import { getConfig, setConfig } from '../lib/config.js';
import { parseTorrent, parseMagnet, isMagnet, formatSize } from '../lib/torrent.js';
import { planDestination } from '../lib/organize.js';
import { episodeCode, QUALITY_LABELS, LANG_LABELS } from '../lib/media.js';
import { findShow } from '../lib/tvmaze.js';
import { icon } from '../lib/icons.js';
import { $, esc, hydrateIcons, copyText } from '../lib/ui.js';
import { initTheme, bindThemeButton } from '../lib/theme.js';
import { openExplorer } from '../ui/explorer.js';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

const PRIORITIES = [
  [0, 'Ne pas télécharger'],
  [1, 'Normale'],
  [6, 'Haute'],
  [7, 'Maximale'],
];
const NEW_CATEGORY = '\u0000new';

const FILE_TYPES = [
  ['video', /\.(mkv|mp4|avi|mov|wmv|m4v|webm|ts|m2ts|mpe?g|flv|vob)$/i],
  ['audio', /\.(mp3|flac|aac|ogg|opus|wav|m4a|alac|ape|wma|dsf)$/i],
  ['image', /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|avif)$/i],
  ['archive', /\.(zip|rar|7z|tar|gz|bz2|xz|zst|r\d\d)$/i],
  ['subtitle', /\.(srt|ass|ssa|sub|idx|vtt|sup)$/i],
  ['disc', /\.(iso|img|bin|cue|dmg|nrg)$/i],
  ['text', /\.(nfo|txt|md|pdf|epub|mobi|azw3|cbz|cbr|docx?)$/i],
];
const TYPE_ICON = {
  video: 'film', audio: 'music', image: 'image', archive: 'archive',
  subtitle: 'captions', disc: 'disc', text: 'fileText', file: 'file',
};

const st = {
  cfg: null,
  client: null,
  caps: {},
  pendingKey: null,
  // Serveur
  serverReady: false,
  defaultsApplied: false,
  defaults: {},
  categories: {},
  newCategories: new Set(),
  lastCategory: '',
  tags: [],
  selectedTags: new Set(),
  manualSavePath: '',
  duplicate: false,
  // Rangement automatique
  plan: null,
  planUndo: null,
  organizedFor: null,
  show: null,
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

const chip = (ic, text, cls = '') => `<span class="chip ${cls}">${icon(ic)}${esc(text)}</span>`;

function fileType(name) {
  for (const [type, re] of FILE_TYPES) if (re.test(name)) return type;
  return 'file';
}

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
  $('status').innerHTML = text ? `<span>${esc(text)}</span>` : '';
  $('status').className = `status ${kind}`;
}

function updateAddButton() {
  $('addBtn').disabled = st.busy || !st.serverReady || !st.mode;
}

// ---------------------------------------------------------------------------
// Client torrent et valeurs par défaut

function applyCaps() {
  const caps = st.caps;
  document.querySelectorAll('[data-cap]').forEach((el) => {
    if (!caps[el.dataset.cap]) el.hidden = true;
  });
  $('categoryLabel').textContent = caps.categoryPaths ? 'Catégorie' : 'Étiquette du client';
  $('noOrgHint').hidden = Boolean(caps.categories || caps.tags || caps.rename);
}

async function loadServer() {
  $('serverDot').className = 'dot wait';
  try {
    const caps = st.caps;
    const [test, defaults, categories, tags] = await Promise.all([
      st.client.test(),
      st.client.defaults(),
      caps.categories ? st.client.categories().catch(() => ({})) : {},
      caps.tags ? st.client.tags().catch(() => []) : [],
    ]);
    st.defaults = defaults;
    st.categories = categories || {};
    st.tags = tags || [];
    st.serverReady = true;
    $('serverDot').className = 'dot ok';
    $('server').textContent = `${new URL(st.cfg.serverUrl).host} · ${test.version}`;
    hideBanner('server');
    if (!st.defaultsApplied) applyDefaults();
    renderCategories($('category').value || undefined);
    renderTags();
    updateDest();
    runOrganize();
  } catch (e) {
    st.serverReady = false;
    $('serverDot').className = 'dot err';
    $('server').textContent = 'Hors ligne';
    showBanner(`Connexion à ${st.client.label} impossible : ${e.message}`, 'error', {
      label: 'Réessayer',
      onClick: () => loadServer().then(checkDuplicate),
    }, 'server');
  }
  updateAddButton();
}

function applyDefaults() {
  const d = st.defaults;
  st.defaultsApplied = true;
  setAuto(Boolean(st.caps.autoTMM && d.autoTMM));
  st.manualSavePath = (st.cfg.rememberLastPath && st.cfg.recentPaths[0]) || d.savePath || '';
  $('savepath').value = st.manualSavePath;
  $('useDownloadPath').checked = Boolean(d.useDownloadPath);
  $('downloadPath').value = d.downloadPath || '';
  $('start').checked = !d.paused;
  $('stopCondition').value = d.stopCondition || 'None';
  $('topQueue').checked = Boolean(d.topQueue);
  $('contentLayout').value = d.contentLayout || 'Original';
  const def = st.cfg.defaultCategory;
  renderCategories(def && st.categories[def] ? def : '');
  $('defaultCategory').checked = Boolean(def) && $('category').value === def;
  updatePaths();
}

const isAuto = () => document.querySelector('input[name="tmm"]:checked').value === 'true';

function setAuto(auto) {
  document.querySelector(`input[name="tmm"][value="${auto}"]`).checked = true;
}

function joinPathLocal(base, name) {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function categoryPath(name) {
  const base = st.defaults.savePath || '';
  if (!name) return base;
  const custom = st.categories[name]?.savePath;
  if (custom) return /^([a-zA-Z]:[\\/]|[\\/])/.test(custom) ? custom : joinPathLocal(base, custom);
  return joinPathLocal(base, name);
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
  $('browseBtn').disabled = auto;
  $('useDownloadPath').disabled = auto;
  $('downloadPathField').hidden = !st.caps.downloadPath || auto || !$('useDownloadPath').checked;
  $('autoHint').hidden = !auto;
  updateDest();
}

function updateDest() {
  const path = isAuto() ? categoryPath(currentCategory()) : $('savepath').value.trim();
  $('destPreview').innerHTML = path
    ? `Destination : <b>${esc(path)}</b>`
    : "Choisis un emplacement d'enregistrement";
  $('destPreview').title = path;
  scheduleFreeSpace(path);
}

// Espace libre à l'emplacement choisi (en remontant si le dossier n'existe pas encore).
let freeTimer;
function scheduleFreeSpace(path) {
  clearTimeout(freeTimer);
  if (!st.caps.freeSpace || !st.serverReady || !path) {
    $('freeHint').textContent = '';
    return;
  }
  freeTimer = setTimeout(async () => {
    let p = path;
    for (let i = 0; i < 4 && p; i++) {
      const free = await st.client.freeSpace(p).catch(() => null);
      if (free != null) {
        $('freeHint').textContent = `${formatSize(free)} libres sur ce disque`;
        return;
      }
      p = parentPath(p);
    }
    $('freeHint').textContent = '';
  }, 400);
}

// ---------------------------------------------------------------------------
// Explorateur

function quickAccess() {
  const items = [
    st.cfg.seriesRoot && { label: 'Séries', path: st.cfg.seriesRoot, icon: 'tv' },
    st.cfg.moviesRoot && { label: 'Films', path: st.cfg.moviesRoot, icon: 'clapperboard' },
    st.defaults.savePath && { label: 'Emplacement par défaut', path: st.defaults.savePath, icon: 'download' },
    ...st.cfg.recentPaths.slice(0, 5).map((p) => ({ label: baseName(p) || p, path: p, icon: 'history' })),
    ...Object.keys(st.categories).filter((c) => st.categories[c].savePath).map((c) => ({ label: c, path: categoryPath(c), icon: 'tag' })),
  ].filter(Boolean);
  const seen = new Set();
  return items.filter((i) => {
    const k = i.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function browse(input, title) {
  const path = await openExplorer({
    client: st.client,
    initial: input.value.trim() || st.defaults.savePath || '',
    quick: quickAccess(),
    title,
  });
  if (!path) return;
  input.value = path;
  if (input === $('savepath')) {
    st.manualSavePath = path;
    hideOrganize();
  }
  updateDest();
}

// ---------------------------------------------------------------------------
// Rangement automatique (séries et films)

function sourceName() {
  if (st.torrent) return st.torrent.name;
  if (st.mode === 'magnet') return st.magnet?.name;
  return st.download ? baseName(st.download.filename) : st.url;
}

async function runOrganize() {
  const name = sourceName();
  if (!name || !st.serverReady || !st.mode || st.organizedFor === name) return;
  st.organizedFor = name;
  let plan = null;
  try {
    plan = await planDestination(st.client, st.cfg, name);
  } catch { /* pas de rangement */ }
  if (!plan?.path) {
    hideOrganize();
    return;
  }

  st.planUndo = {
    auto: isAuto(),
    savepath: $('savepath').value,
    category: $('category').value,
    layout: $('contentLayout').value,
  };
  st.plan = plan;
  setAuto(false);
  updatePaths();
  $('savepath').value = plan.path;
  st.manualSavePath = plan.path;
  if (plan.category && st.caps.categories) {
    if (!st.categories[plan.category]) st.newCategories.add(plan.category);
    renderCategories(plan.category);
  }
  if (plan.layout && st.caps.contentLayout) $('contentLayout').value = plan.layout;
  updatePaths();
  renderOrganize();
  if (plan.kind !== 'movie') loadPoster(plan.info.title);
}

function renderOrganize() {
  const plan = st.plan;
  const box = $('organizeBox');
  if (!plan) {
    box.hidden = true;
    return;
  }
  const { info } = plan;
  const steps = [];
  if (plan.kind === 'movie') {
    $('orgTitle').textContent = `${plan.movieName}${info.year ? ` (${info.year})` : ''}`;
    steps.push(chip('clapperboard', 'Film', 'accent'));
    steps.push(chip('folder', 'Dossier des films'));
  } else {
    $('orgTitle').textContent = `${plan.seriesName} · ${episodeCode(info)}`;
    steps.push(plan.seriesExists
      ? chip('check', `Dossier « ${plan.seriesName} » trouvé`, 'ok')
      : chip('folderPlus', `Nouveau dossier « ${plan.seriesName} »`, 'accent'));
    if (plan.seasonName) {
      steps.push(plan.seasonExists
        ? chip('check', `« ${plan.seasonName} » trouvé`, 'ok')
        : chip('folderPlus', `« ${plan.seasonName} » sera créé`, 'accent'));
    }
    if (!plan.verified) steps.push(chip('info', 'Dossiers non vérifiés', 'warn'));
  }
  if (info.quality) steps.push(chip('film', QUALITY_LABELS[info.quality] || info.quality));
  if (info.lang) steps.push(chip('message', LANG_LABELS[info.lang] || info.lang));
  $('orgSteps').innerHTML = steps.join('');
  $('orgIcon').innerHTML = st.show?.poster ? `<img src="${esc(st.show.poster)}" alt="">` : icon(plan.kind === 'movie' ? 'clapperboard' : 'tv');
  $('orgUndo').hidden = false;
  box.hidden = false;
}

function hideOrganize() {
  $('organizeBox').hidden = true;
  st.plan = null;
}

function undoOrganize() {
  const u = st.planUndo;
  if (u) {
    setAuto(u.auto);
    $('savepath').value = u.savepath;
    st.manualSavePath = u.savepath;
    renderCategories(u.category);
    $('contentLayout').value = u.layout;
    updatePaths();
  }
  hideOrganize();
}

async function loadPoster(title) {
  try {
    const show = await findShow(title);
    if (!show?.poster) return;
    st.show = show;
    const hero = $('heroIcon');
    hero.classList.add('poster');
    hero.innerHTML = `<img src="${esc(show.poster)}" alt="">`;
    renderOrganize();
    renderHero();
  } catch { /* affiche facultative */ }
}

// ---------------------------------------------------------------------------
// Catégories, étiquettes

function currentCategory() {
  const v = $('category').value;
  return v === NEW_CATEGORY ? '' : v;
}

function renderCategories(selected) {
  const sel = $('category');
  sel.innerHTML = '';
  sel.append(new Option(st.caps.categoryPaths ? 'Aucune catégorie' : 'Aucune', ''));
  for (const name of Object.keys(st.categories).sort(collator.compare)) sel.append(new Option(name, name));
  for (const name of st.newCategories) if (!st.categories[name]) sel.append(new Option(`${name} (nouvelle)`, name));
  sel.append(new Option('＋ Nouvelle…', NEW_CATEGORY));
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

function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
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
        await useTorrentBytes(await readDownloaded(src), baseName(src.filename));
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
      st.hintName = src.name || '';
      try {
        await useTorrentBytes(await fetchTorrent(src.url), filenameFromUrl(src.url));
      } catch (e) {
        useUrlOnly(src.url);
        showBanner(`L'extension n'a pas pu lire ce torrent (${e.message}). Le client le téléchargera lui-même.`, 'warn');
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
  runOrganize();
}

function displayName() {
  if (st.torrent) return st.torrent.name;
  if (st.mode === 'magnet') return st.magnet.name;
  return st.hintName || filenameFromUrl(st.url) || st.url;
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

  const hero = $('heroIcon');
  if (!hero.classList.contains('poster')) {
    hero.innerHTML = icon(t ? TYPE_ICON[dominantType(t.files)] : st.mode === 'magnet' ? 'magnet' : 'globe');
  }

  const chips = [];
  if (st.show) chips.push(chip('tv', [st.show.name, st.show.network].filter(Boolean).join(' · '), 'accent'));
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
    chips.push(chip('globe', 'Téléchargé par le client', 'accent'));
  }
  if (st.duplicate) chips.push(chip('alert', 'Déjà dans le client', 'err'));
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
  const choices = st.caps.filePriorities === 'full' ? PRIORITIES : PRIORITIES.filter(([v]) => v <= 1);
  const disabled = st.caps.filePriorities ? '' : 'disabled';
  return `<select class="input prio p${mixed ? 'mixed' : value}" data-prio ${disabled}>${mixed ? '<option value="" selected>Mixte</option>' : ''}${
    choices.map(([v, label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('')
  }</select>`;
}

function emptyState(ic, title, text) {
  return `<span class="big-ico">${icon(ic)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p>`;
}

function renderFiles() {
  const body = $('filesBody');
  const empty = $('filesEmpty');
  const isTorrent = st.mode === 'torrent';
  const canPick = Boolean(st.caps.filePriorities);
  ['selAll', 'selNone', 'filter', 'checkAll', 'expandBtn'].forEach((id) => { $(id).disabled = !isTorrent; });
  ['selAll', 'selNone', 'checkAll'].forEach((id) => { if (!canPick) $(id).disabled = true; });

  if (!isTorrent) {
    body.innerHTML = '';
    $('filesCount').textContent = '';
    $('filesSub').textContent = 'Liste indisponible pour le moment';
    empty.hidden = false;
    empty.innerHTML = st.mode === 'magnet'
      ? emptyState('magnet', 'Lien magnet', "La liste des fichiers sera connue quand le client aura récupéré les métadonnées.")
      : emptyState('globe', 'Téléchargé par le client', "Le client récupérera lui-même le fichier .torrent : la liste des fichiers n'est pas disponible ici.");
    $('filesSummary').textContent = '';
    $('meterFill').style.width = '0';
    return;
  }

  const files = st.torrent.files;
  $('filesCount').textContent = files.length;
  $('filesSub').textContent = canPick
    ? `${formatSize(st.torrent.totalSize)} au total`
    : `${formatSize(st.torrent.totalSize)} · ${st.client?.label || 'Ce client'} ne permet pas de choisir les fichiers à l'ajout`;
  const filter = st.filter.toLowerCase();
  const matches = (i) => !filter || files[i].path.toLowerCase().includes(filter);
  const rows = [];
  const disabled = canPick ? '' : 'disabled';

  const walk = (node, depth) => {
    const pad = depth * 20;
    for (const dir of [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name))) {
      if (!dir.indexes.some(matches)) continue;
      const selected = dir.indexes.filter((i) => st.prio[i] > 0).length;
      const values = new Set(dir.indexes.map((i) => st.prio[i]));
      const collapsed = !filter && st.collapsed.has(dir.path);
      rows.push(`<tr class="dir${selected ? '' : ' off'}" data-dir="${esc(dir.path)}">
        <td class="c-check"><input type="checkbox" ${disabled} ${selected === dir.indexes.length ? 'checked' : ''} ${selected && selected < dir.indexes.length ? 'data-mixed' : ''}></td>
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
        <td class="c-check"><input type="checkbox" ${disabled} ${p > 0 ? 'checked' : ''}></td>
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
    const name = await st.client.exists(id);
    if (name) {
      st.duplicate = true;
      renderHero();
      showBanner(`Ce torrent est déjà présent dans ${st.client.label} (« ${name} »).`, 'warn', null, 'duplicate');
    }
  } catch { /* simple vérification */ }
}

// ---------------------------------------------------------------------------
// Envoi

const ADD_BTN_HTML = () => `${icon('download')}<span>Ajouter</span><kbd>Ctrl ↵</kbd>`;

async function submit() {
  if (st.busy || !st.mode || $('addBtn').disabled) return;
  const caps = st.caps;
  const auto = caps.autoTMM && isAuto();
  const savepath = $('savepath').value.trim();
  const category = caps.categories ? currentCategory() : '';
  const customPrio = st.mode === 'torrent' && caps.filePriorities && st.prio.some((p) => p !== 1);

  if (customPrio && st.prio.every((p) => p === 0)) {
    setStatus('Aucun fichier sélectionné.', 'error');
    return;
  }

  st.busy = true;
  updateAddButton();
  $('addBtn').innerHTML = '<span class="spinner"></span><span>Envoi…</span>';
  setStatus('');

  try {
    const dl = Number($('dlLimit').value);
    const up = Number($('upLimit').value);
    await st.client.add({
      torrent: st.mode === 'torrent' ? st.bytes : null,
      filename: st.filename,
      url: st.mode === 'magnet' ? st.magnet.uri : st.url,
      hash: st.torrent?.id || st.magnet?.id || null,
      autoTMM: caps.autoTMM ? auto : null,
      savePath: auto ? '' : savepath,
      useDownloadPath: caps.downloadPath ? $('useDownloadPath').checked : null,
      downloadPath: $('downloadPath').value.trim(),
      category,
      tags: caps.tags ? [...st.selectedTags] : [],
      newTags: caps.tags ? [...st.selectedTags].filter((t) => !st.tags.includes(t)) : [],
      rename: caps.rename ? $('rename').value.trim() : '',
      paused: !$('start').checked,
      stopCondition: caps.stopCondition ? $('stopCondition').value : null,
      topQueue: caps.topQueue ? $('topQueue').checked : null,
      skipChecking: caps.skipChecking && $('skipChecking').checked,
      sequential: caps.sequential && $('sequential').checked,
      firstLast: caps.firstLast && $('firstLast').checked,
      contentLayout: caps.contentLayout ? $('contentLayout').value : null,
      dlLimit: caps.limits && dl > 0 ? dl * 1024 : 0,
      upLimit: caps.limits && up > 0 ? up * 1024 : 0,
      filePriorities: customPrio ? st.prio.slice() : null,
    });
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
      title: `Torrent envoyé à ${st.client.label}`,
      message: savepath ? `${name}\n→ ${savepath}` : name,
    });
  }

  $('successName').textContent = name;
  $('successPath').textContent = savepath ? `Enregistré dans ${savepath}` : '';
  $('successActions').hidden = cfg.closeAfterAdd;
  $('successHint').textContent = cfg.closeAfterAdd ? 'Cette fenêtre va se fermer…' : '';
  $('success').hidden = false;
  if (cfg.closeAfterAdd) setTimeout(() => window.close(), 1600);
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
  $('savepath').addEventListener('input', (e) => {
    st.manualSavePath = e.target.value;
    if (st.plan) hideOrganize();
    updateDest();
  });
  $('browseBtn').addEventListener('click', () => browse($('savepath'), "Choisir l'emplacement d'enregistrement"));
  $('browseDlBtn').addEventListener('click', () => browse($('downloadPath'), 'Dossier des téléchargements incomplets'));
  $('orgUndo').addEventListener('click', undoOrganize);

  $('tagsBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('tagsMenu');
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
    if (open) $('newTag').focus();
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
    if (document.querySelector('.xp-backdrop')) return;
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
  $('successWebui').addEventListener('click', () => chrome.tabs.create({ url: st.client.webUrl }));

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
    showBanner("Aucun client torrent n'est configuré.", 'error', {
      label: 'Ouvrir les paramètres',
      onClick: () => chrome.runtime.openOptionsPage(),
    });
    return;
  }
  st.client = createClient(st.cfg);
  st.caps = st.client.caps;
  applyCaps();
  $('server').textContent = `${new URL(st.cfg.serverUrl).host} · ${st.client.label}`;

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
