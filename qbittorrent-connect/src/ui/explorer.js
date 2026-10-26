// Gestionnaire de fichiers du serveur, façon Explorateur Windows : disques avec
// espace libre, accès rapide, dossiers et fichiers, tri, recherche, deux vues.
//
//   const path = await pickFolder({ qbt, cfg, initial, need });   // choix d'un dossier (fenêtre modale)
//   new Explorer(element, { qbt, cfg, initial });                  // page complète
//
// `quick` (raccourcis de la barre latérale) est calculé à partir du serveur
// s'il n'est pas fourni.
import { icon } from '../lib/icons.js';
import { esc } from '../lib/ui.js';
import { setConfig } from '../lib/config.js';
import { formatSize } from '../lib/torrent.js';
import { fileType, typeLabel, TYPE_ICON } from '../lib/filetypes.js';
import { normalizePath, parentPath, joinPath, rootOf, crumbs, samePath, safeFolderName, pathKey } from '../lib/paths.js';
import { loadStorage, driveName, driveFor, freeLevel, quickAccess } from '../lib/storage.js';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const PREFS_KEY = 'qbc-explorer';
const PREF_DEFAULTS = { view: 'details', showFiles: true, sort: 'name', dir: 1 };

const SORTERS = {
  name: (a, b) => collator.compare(a.name, b.name),
  modified: (a, b) => (a.modified || 0) - (b.modified || 0),
  type: (a, b) => collator.compare(a.typeLabel, b.typeLabel),
  size: (a, b) => (a.size || 0) - (b.size || 0),
};
const COLUMNS = [['name', 'Nom'], ['modified', 'Modifié le'], ['type', 'Type'], ['size', 'Taille']];

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleString('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '');

function readPrefs() {
  try {
    return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

function decorate(e) {
  if (e.type === 'dir') return { ...e, ftype: 'folder', typeLabel: 'Dossier de fichiers' };
  return { ...e, ftype: fileType(e.name), typeLabel: typeLabel(e.name) };
}

const entryIcon = (e) => icon(e.type === 'dir' ? 'folder' : TYPE_ICON[e.ftype]);
const driveIcon = (d) => icon(d.kind === 'network' ? 'network' : 'hardDrive');

export class Explorer {
  constructor(el, { qbt, cfg, initial = '', quick = null, prefs = null, pick = false, need = 0, onChoose, onCancel, onNavigate } = {}) {
    Object.assign(this, { el, qbt, cfg, pick, need, onChoose, onCancel, onNavigate });
    this.quick = quick || [];
    this.autoQuick = !quick;
    this.serverPrefs = prefs;
    const p = readPrefs();
    this.st = {
      path: null, // null = « Ce PC »
      back: [],
      fwd: [],
      entries: [],
      loading: false,
      error: null,
      selected: null,
      filter: '',
      view: p.view,
      showFiles: p.showFiles,
      sort: p.sort,
      dir: p.dir,
      storage: null,
      newFolder: false,
      editingAddress: false,
      created: new Map(), // dossiers créés ici, qui n'existent pas encore sur le serveur
    };
    this.token = 0;
    this.onKey = this.onKey.bind(this);
    this.build();
    document.addEventListener('keydown', this.onKey, true);
    this.loadStorage();
    this.go(initial || null, { push: false });
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey, true);
  }

  $(sel) { return this.el.querySelector(sel); }

  // -------------------------------------------------------------------------
  // Structure et événements

  build() {
    this.el.classList.add('xp');
    this.el.classList.toggle('xp-pick', this.pick);
    this.el.innerHTML = `
      <div class="xp-toolbar">
        <div class="xp-nav">
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="back" title="Précédent (Alt+←)">${icon('arrowLeft')}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="fwd" title="Suivant (Alt+→)">${icon('arrowRight')}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="up" title="Dossier parent (Retour arrière)">${icon('arrowUp')}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="refresh" title="Actualiser (F5)">${icon('refresh')}</button>
        </div>
        <div class="xp-address" data-act="address" title="Cliquer pour saisir un chemin (Ctrl+L)">
          <div class="xp-crumbs"></div>
          <input class="xp-address-input" type="text" spellcheck="false" hidden>
        </div>
        <div class="field-icon xp-search">
          <i data-icon="search">${icon('search')}</i>
          <input class="input" type="search" placeholder="Rechercher" spellcheck="false">
        </div>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="files"></button>
        <div class="seg xp-views">
          <label title="Détails"><input type="radio" name="xp-view" value="details"><span>${icon('list')}</span></label>
          <label title="Grandes icônes"><input type="radio" name="xp-view" value="icons"><span>${icon('grid')}</span></label>
        </div>
      </div>
      <div class="xp-body">
        <nav class="xp-side"></nav>
        <section class="xp-main"></section>
      </div>
      <div class="xp-status"><span class="xp-count"></span><span class="xp-drive-status"></span></div>
      ${this.pick ? `<footer class="xp-foot">
        <button type="button" class="btn btn-sm" data-act="newfolder">${icon('folderPlus')}Nouveau dossier</button>
        <div class="xp-picked"></div>
        <button type="button" class="btn btn-ghost" data-act="cancel">Annuler</button>
        <button type="button" class="btn btn-primary" data-act="choose">${icon('check')}Sélectionner ce dossier</button>
      </footer>` : ''}`;

    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.$('.xp-views').addEventListener('change', (e) => {
      this.st.view = e.target.value;
      this.savePrefs();
      this.renderMain();
    });
    this.$('.xp-search input').addEventListener('input', (e) => {
      this.st.filter = e.target.value.trim();
      this.renderMain();
      this.renderStatus();
    });
    const addr = this.$('.xp-address-input');
    addr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = addr.value.trim();
      this.editAddress(false);
      if (value) this.go(value);
    });
    addr.addEventListener('blur', () => this.editAddress(false));
  }

  onClick(e) {
    const t = e.target;
    const rename = t.closest('[data-rename]');
    if (rename) {
      e.stopPropagation();
      this.renameDrive(rename.dataset.rename);
      return;
    }
    const sort = t.closest('[data-sort]');
    if (sort) {
      this.toggleSort(sort.dataset.sort);
      return;
    }
    const go = t.closest('[data-go]');
    if (go) {
      this.go(go.dataset.go || null);
      return;
    }
    const item = t.closest('.xp-main [data-path]');
    if (item) {
      this.select(item.dataset.path);
      return;
    }
    switch (t.closest('[data-act]')?.dataset.act) {
      case 'back': this.back(); break;
      case 'fwd': this.forward(); break;
      case 'up': this.up(); break;
      case 'refresh': this.refresh(); break;
      case 'address': this.editAddress(true); break;
      case 'files':
        this.st.showFiles = !this.st.showFiles;
        this.savePrefs();
        this.renderBar();
        this.renderMain();
        this.renderStatus();
        break;
      case 'newfolder': this.startNewFolder(); break;
      case 'create': this.commitNewFolder(); break;
      case 'cancel': this.onCancel?.(); break;
      case 'choose': this.choose(); break;
      default:
        // Clic dans le vide : plus de sélection.
        if (t.closest('.xp-main') && !t.closest('input, button')) this.select(null);
    }
  }

  onDblClick(e) {
    const item = e.target.closest('.xp-main [data-path]');
    if (!item || e.target.closest('[data-rename]')) return;
    if (item.dataset.kind !== 'file') this.go(item.dataset.path);
  }

  onKey(e) {
    if (!this.el.isConnected) return;
    const st = this.st;
    const t = e.target;
    if (e.key === 'Escape') {
      if (st.editingAddress) this.editAddress(false);
      else if (st.newFolder) this.cancelNewFolder();
      else if (this.pick) this.onCancel?.();
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (this.pick && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      this.choose();
      return;
    }
    if (t.matches?.('.xp-new-input') && e.key === 'Enter') {
      e.preventDefault();
      this.commitNewFolder();
      return;
    }
    if (t.matches?.('input, textarea, select')) return;
    if (t.matches?.('button, a') && (e.key === 'Enter' || e.key === ' ')) return;

    if ((e.ctrlKey && e.key.toLowerCase() === 'l') || e.key === 'F4') this.editAddress(true);
    else if (e.altKey && e.key === 'ArrowLeft') this.back();
    else if (e.altKey && e.key === 'ArrowRight') this.forward();
    else if ((e.altKey && e.key === 'ArrowUp') || e.key === 'Backspace') this.up();
    else if (e.key === 'F5') this.refresh();
    else if (e.key === 'Enter') {
      const kind = st.selected && this.kindOf(st.selected);
      if (!kind || kind === 'file') return;
      this.go(st.selected);
    } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && !e.altKey) {
      this.moveSelection(e.key);
    } else return;
    e.preventDefault();
  }

  savePrefs() {
    const { view, showFiles, sort, dir } = this.st;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ view, showFiles, sort, dir })); } catch { /* préférence non mémorisée */ }
  }

  // -------------------------------------------------------------------------
  // Navigation

  go(path, { push = true, keepSelection = false } = {}) {
    const st = this.st;
    const next = path ? normalizePath(path) : null;
    const prev = st.path;
    const same = next === null ? prev === null : samePath(next, prev);
    if (push && !same) {
      st.back.push(prev);
      st.fwd = [];
    }
    st.path = next;
    if (!keepSelection) {
      // En remontant, le dossier d'où l'on vient reste sélectionné, comme dans Windows.
      const cameFromChild = prev && (next === null ? samePath(rootOf(prev), prev) : samePath(parentPath(prev), next));
      st.selected = cameFromChild ? prev : null;
    }
    st.filter = '';
    this.$('.xp-search input').value = '';
    st.error = null;
    st.entries = [];
    st.newFolder = false;
    this.editAddress(false);
    this.onNavigate?.(next);

    const token = ++this.token;
    st.loading = next !== null;
    this.render();
    if (next === null) return;
    this.qbt.dirContent(next).then(
      (entries) => { if (token === this.token) st.entries = entries.map(decorate); },
      (err) => { if (token === this.token) st.error = err; },
    ).finally(() => {
      if (token !== this.token) return;
      st.loading = false;
      this.render();
    });
  }

  back() {
    const st = this.st;
    if (!st.back.length) return;
    st.fwd.push(st.path);
    this.go(st.back.pop(), { push: false });
  }

  forward() {
    const st = this.st;
    if (!st.fwd.length) return;
    st.back.push(st.path);
    this.go(st.fwd.pop(), { push: false });
  }

  up() {
    if (this.st.path !== null) this.go(parentPath(this.st.path));
  }

  refresh() {
    this.loadStorage(true);
    this.go(this.st.path, { push: false, keepSelection: true });
  }

  editAddress(on) {
    const st = this.st;
    if (st.editingAddress === on) return;
    st.editingAddress = on;
    const input = this.$('.xp-address-input');
    this.$('.xp-crumbs').hidden = on;
    input.hidden = !on;
    if (on) {
      input.value = st.path || '';
      input.focus();
      input.select();
    }
  }

  async loadStorage(refresh = false) {
    const st = this.st;
    st.storage = null;
    this.renderSide();
    if (st.path === null) this.renderMain();
    try {
      st.storage = await loadStorage(this.qbt, { serverUrl: this.cfg.serverUrl, prefs: this.serverPrefs, refresh });
    } catch (e) {
      st.storage = { drives: [], browse: true, freeApi: true, error: e.message };
    }
    if (this.autoQuick && st.storage.prefs) {
      this.quick = quickAccess({ prefs: st.storage.prefs, categories: st.storage.categories, recentPaths: this.cfg.recentPaths });
    }
    this.renderSide();
    this.renderBar();
    this.renderStatus();
    this.renderFoot();
    // Ne pas effacer un nom de dossier en cours de saisie.
    if (st.path === null && !st.newFolder) this.renderMain();
  }

  // -------------------------------------------------------------------------
  // Sélection

  itemNodes() {
    return [...this.el.querySelectorAll('.xp-main [data-path]')];
  }

  kindOf(path) {
    return this.itemNodes().find((n) => samePath(n.dataset.path, path))?.dataset.kind || null;
  }

  select(path) {
    this.st.selected = path;
    for (const n of this.itemNodes()) {
      const on = Boolean(path) && samePath(n.dataset.path, path);
      n.classList.toggle('selected', on);
      if (on) n.scrollIntoView({ block: 'nearest' });
    }
    this.renderStatus();
    this.renderFoot();
  }

  moveSelection(key) {
    const nodes = this.itemNodes();
    if (!nodes.length) return;
    const i = nodes.findIndex((n) => this.st.selected && samePath(n.dataset.path, this.st.selected));
    const icons = this.st.view === 'icons' && this.st.path !== null;
    const cols = icons ? nodes.filter((n) => n.offsetTop === nodes[0].offsetTop).length : 1;
    let j;
    if (key === 'Home') j = 0;
    else if (key === 'End') j = nodes.length - 1;
    else if (i < 0) j = 0;
    else if (key === 'ArrowDown') j = i + cols;
    else if (key === 'ArrowUp') j = i - cols;
    else if (key === 'ArrowRight') j = i + 1;
    else j = i - 1;
    this.select(nodes[Math.max(0, Math.min(nodes.length - 1, j))].dataset.path);
  }

  // Dossier qui sera choisi : le dossier sélectionné, sinon le dossier ouvert.
  target() {
    const { selected, path } = this.st;
    const kind = selected && this.kindOf(selected);
    return kind && kind !== 'file' ? selected : path;
  }

  choose() {
    const t = this.target();
    if (t) this.onChoose?.(t);
  }

  toggleSort(key) {
    const st = this.st;
    if (st.sort === key) st.dir = -st.dir;
    else {
      st.sort = key;
      st.dir = key === 'modified' || key === 'size' ? -1 : 1;
    }
    this.savePrefs();
    this.renderMain();
  }

  // -------------------------------------------------------------------------
  // Nouveau dossier (créé par qBittorrent au premier téléchargement)

  startNewFolder() {
    if (this.st.path === null) return;
    this.st.newFolder = true;
    this.renderMain();
    const input = this.$('.xp-new-input');
    input.focus();
    input.select();
  }

  commitNewFolder() {
    const st = this.st;
    const input = this.$('.xp-new-input');
    if (!st.newFolder || !input) return;
    const name = safeFolderName(input.value);
    st.newFolder = false;
    if (name) {
      const lower = name.toLowerCase();
      const existing = st.entries.find((e) => e.type === 'dir' && e.name.toLowerCase() === lower);
      const key = pathKey(st.path);
      const list = st.created.get(key) || [];
      if (!existing && !list.some((n) => n.toLowerCase() === lower)) list.push(name);
      st.created.set(key, list);
      st.selected = existing ? existing.path : joinPath(st.path, name);
    }
    this.renderMain();
    this.renderStatus();
    this.renderFoot();
  }

  cancelNewFolder() {
    this.st.newFolder = false;
    this.renderMain();
  }

  async renameDrive(root) {
    const names = { ...(this.cfg.driveNames || {}) };
    const value = prompt(`Nom affiché pour ${root} (vide = nom par défaut) :`, names[root] || '');
    if (value === null) return;
    if (value.trim()) names[root] = value.trim();
    else delete names[root];
    this.cfg.driveNames = names;
    await setConfig({ driveNames: names });
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendu

  render() {
    this.renderSide();
    this.renderBar();
    this.renderMain();
    this.renderStatus();
    this.renderFoot();
  }

  driveLabel(root) {
    return driveName(root, this.cfg.driveNames);
  }

  renderSide() {
    const st = this.st;
    const item = (path, label, ic, meta = '', extra = '') => {
      const active = path ? samePath(path, st.path) : st.path === null;
      return `<button type="button" class="xp-side-item${active ? ' active' : ''}${extra}" data-go="${esc(path)}" title="${esc(path || 'Disques du serveur')}">
        ${ic}<span class="xp-side-label">${esc(label)}</span>${meta ? `<span class="xp-side-meta">${esc(meta)}</span>` : ''}
      </button>`;
    };
    const groups = new Map();
    for (const q of this.quick) {
      if (!groups.has(q.group)) groups.set(q.group, []);
      groups.get(q.group).push(q);
    }
    let html = '';
    for (const [group, items] of groups) {
      html += `<div class="xp-side-group">${esc(group)}</div>${items.map((q) => item(q.path, q.label, icon(q.icon || 'folder'))).join('')}`;
    }
    html += `<div class="xp-side-group">Serveur</div>${item('', 'Ce PC', icon('monitor'))}`;
    html += st.storage
      ? st.storage.drives.map((d) => item(d.root, this.driveLabel(d.root), driveIcon(d), d.free != null ? formatSize(d.free) : '', d.missing ? ' missing' : '')).join('')
      : '<div class="xp-side-loading"><span class="spinner"></span></div>';
    this.$('.xp-side').innerHTML = html;
  }

  renderBar() {
    const st = this.st;
    const list = crumbs(st.path);
    const el = this.$('.xp-crumbs');
    el.innerHTML = `<button type="button" class="xp-crumb" data-go="">${icon('monitor')}<span>Ce PC</span></button>${
      list.map((c, i) => `<span class="xp-sep">${icon('chevronRight')}</span><button type="button" class="xp-crumb" data-go="${esc(c.path)}" title="${esc(c.path)}">${esc(i === 0 ? this.driveLabel(c.path) : c.label)}</button>`).join('')}`;
    el.scrollLeft = el.scrollWidth;
    this.$('[data-act="back"]').disabled = !st.back.length;
    this.$('[data-act="fwd"]').disabled = !st.fwd.length;
    this.$('[data-act="up"]').disabled = st.path === null;
    this.$('.xp-search input').disabled = st.path === null;
    this.$(`.xp-views input[value="${st.view}"]`).checked = true;
    const files = this.$('[data-act="files"]');
    files.innerHTML = icon(st.showFiles ? 'file' : 'eyeOff');
    files.title = st.showFiles ? 'Masquer les fichiers (dossiers seulement)' : 'Afficher aussi les fichiers';
    files.classList.toggle('is-on', !st.showFiles);
    if (this.pick) this.$('[data-act="newfolder"]').disabled = st.path === null;
  }

  visibleEntries() {
    const st = this.st;
    const created = (st.created.get(pathKey(st.path)) || []).map((name) => ({
      name, path: joinPath(st.path, name), type: 'dir', created: true, ftype: 'folder', typeLabel: 'Nouveau dossier',
    }));
    const q = st.filter.toLowerCase();
    const sorter = SORTERS[st.sort] || SORTERS.name;
    return [...created, ...st.entries]
      .filter((e) => (st.showFiles || e.type === 'dir') && (!q || e.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; // dossiers d'abord
        return sorter(a, b) * st.dir || SORTERS.name(a, b);
      });
  }

  renderMain() {
    const st = this.st;
    let html;
    if (st.path === null) html = this.computerHtml();
    else if (st.loading) html = '<div class="xp-empty"><span class="spinner"></span><p>Chargement…</p></div>';
    else {
      const list = this.visibleEntries();
      const content = list.length ? (st.view === 'icons' ? this.iconsHtml(list) : this.detailsHtml(list)) : '';
      if (st.error) html = this.errorHtml(st.error, Boolean(content)) + content;
      else html = content || this.emptyHtml();
    }
    if (st.newFolder) {
      html = `<div class="xp-newbar">
        ${icon('folderPlus')}
        <input class="input xp-new-input" type="text" value="Nouveau dossier" spellcheck="false">
        <button type="button" class="btn btn-sm btn-primary" data-act="create">Créer</button>
        <span class="faint small">Il sera créé sur le serveur au premier téléchargement.</span>
      </div>${html}`;
    }
    const main = this.$('.xp-main');
    main.innerHTML = html;
    main.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  detailsHtml(list) {
    const st = this.st;
    const head = COLUMNS.map(([key, label]) => `<button type="button" class="xp-th${st.sort === key ? ' sorted' : ''}" data-sort="${key}">
      <span>${label}</span>${st.sort === key ? `<span class="xp-sort-ico${st.dir < 0 ? ' desc' : ''}">${icon('chevronDown')}</span>` : ''}
    </button>`).join('');
    const rows = list.map((e) => `
      <div class="xp-row ${e.type}${this.isSelected(e.path) ? ' selected' : ''}" data-path="${esc(e.path)}" data-kind="${e.type}" title="${esc(e.path)}">
        <span class="xp-name"><span class="ftype ${e.ftype}">${entryIcon(e)}</span><span class="xp-label">${esc(e.name)}</span>${e.created ? '<span class="chip accent xp-new">nouveau</span>' : ''}</span>
        <span>${e.created ? 'sera créé' : fmtDate(e.modified)}</span>
        <span>${esc(e.typeLabel)}</span>
        <span class="xp-size">${e.type === 'file' && e.size != null ? formatSize(e.size) : ''}</span>
      </div>`).join('');
    return `<div class="xp-list" role="grid"><div class="xp-row xp-head">${head}</div>${rows}</div>`;
  }

  iconsHtml(list) {
    return `<div class="xp-grid">${list.map((e) => `
      <div class="xp-cell ${e.type}${this.isSelected(e.path) ? ' selected' : ''}" data-path="${esc(e.path)}" data-kind="${e.type}" title="${esc(e.name)}">
        <span class="xp-cell-ico ftype ${e.ftype}">${entryIcon(e)}</span>
        <span class="xp-cell-name">${esc(e.name)}</span>
        ${e.created ? '<span class="chip accent xp-new">nouveau</span>' : e.type === 'file' && e.size != null ? `<span class="xp-cell-sub">${formatSize(e.size)}</span>` : ''}
      </div>`).join('')}</div>`;
  }

  isSelected(path) {
    return Boolean(this.st.selected) && samePath(path, this.st.selected);
  }

  errorHtml(err, compact) {
    let ic = 'alert';
    let text = err.message;
    if (err.code === 'NOT_FOUND') {
      ic = 'folderPlus';
      text = this.pick
        ? "Ce dossier n'existe pas encore : qBittorrent le créera au premier téléchargement."
        : "Ce dossier n'existe pas sur le serveur.";
    } else if (err.code === 'UNSUPPORTED') {
      ic = 'info';
      if (this.pick) text += ' Le chemin sera utilisé tel quel.';
    }
    if (compact) return `<div class="xp-notice xp-inline">${icon(ic)}<p>${esc(text)}</p></div>`;
    const retry = err.code === 'NOT_FOUND' || err.code === 'UNSUPPORTED'
      ? '' : `<button type="button" class="btn btn-sm" data-act="refresh">${icon('refresh')}Réessayer</button>`;
    return `<div class="xp-empty">${icon(ic)}<p>${esc(text)}</p>${retry}</div>`;
  }

  emptyHtml() {
    const st = this.st;
    if (st.filter) return `<div class="xp-empty">${icon('search')}<p>Aucun élément ne correspond à « ${esc(st.filter)} ».</p></div>`;
    const hidden = st.entries.filter((e) => e.type === 'file').length;
    if (hidden) {
      return `<div class="xp-empty">${icon('eyeOff')}<p>Ce dossier ne contient que des fichiers (${hidden}), masqués pour le moment.</p>
        <button type="button" class="btn btn-sm" data-act="files">${icon('file')}Afficher les fichiers</button></div>`;
    }
    return `<div class="xp-empty">${icon('folderOpen')}<p>Ce dossier est vide.</p></div>`;
  }

  // « Ce PC » : disques du serveur et accès rapide.
  computerHtml() {
    const s = this.st.storage;
    if (!s) return '<div class="xp-empty"><span class="spinner"></span><p>Recherche des disques du serveur…</p></div>';
    const drives = s.drives;
    const notices = [];
    if (s.error) notices.push(['alert', `Impossible de lister les disques : ${s.error}`]);
    if (!s.browse) {
      notices.push(['info', `Ta version de qBittorrent${s.version ? ` (${s.version})` : ''} ne permet pas de parcourir les dossiers du serveur : il faut la 5.0 ou plus récente. Les disques ci-dessous viennent de tes torrents et catégories ; tu peux aussi taper un chemin dans la barre d'adresse.`]);
    } else if (!s.freeApi) {
      notices.push(['info', `qBittorrent${s.version ? ` ${s.version}` : ''} ne donne que l'espace libre de l'emplacement par défaut. Passe à qBittorrent 5.3 ou plus récent pour voir l'espace libre de chaque disque.`]);
    }

    const present = drives.filter((d) => !d.missing);
    const withFree = present.filter((d) => d.free != null);
    const totals = drives.reduce((acc, d) => {
      if (d.usage) {
        acc.count += d.usage.count;
        acc.size += d.usage.done;
        acc.remaining += d.usage.remaining;
      }
      return acc;
    }, { count: 0, size: 0, remaining: 0 });
    const summary = [
      [String(present.length), present.length > 1 ? 'disques' : 'disque'],
      withFree.length ? [formatSize(withFree.reduce((sum, d) => sum + d.free, 0)), withFree.length > 1 ? 'libres au total' : 'libres'] : null,
      totals.count ? [formatSize(totals.size), `dans ${plural(totals.count, 'torrent')}`] : null,
      totals.remaining ? [formatSize(totals.remaining), 'restent à télécharger'] : null,
    ].filter(Boolean);

    const quick = this.quick.length ? `
      <h3 class="xp-section">Accès rapide</h3>
      <div class="xp-tiles">${this.quick.map((q) => `
        <div class="xp-tile${this.isSelected(q.path) ? ' selected' : ''}" data-path="${esc(q.path)}" data-kind="quick" title="${esc(q.path)}">
          <span class="xp-tile-ico">${icon(q.icon || 'folder')}</span>
          <span class="xp-tile-text"><b>${esc(q.label)}</b><span class="faint small">${esc(q.path)}</span></span>
        </div>`).join('')}</div>` : '';

    return `<div class="xp-computer">
      ${notices.map(([ic, text]) => `<div class="xp-notice">${icon(ic)}<p>${esc(text)}</p></div>`).join('')}
      <h3 class="xp-section">Disques du serveur <span class="count">${drives.length}</span></h3>
      <div class="xp-summary">${summary.map(([v, l]) => `<div><span class="xp-sum-val">${esc(v)}</span><span>${esc(l)}</span></div>`).join('')}</div>
      <div class="xp-drives">${drives.map((d) => this.driveCard(d)).join('') || '<p class="faint">Aucun disque trouvé.</p>'}</div>
      ${quick}
    </div>`;
  }

  driveCard(d) {
    const u = d.usage;
    const level = d.missing ? 'none' : freeLevel(d.free, u?.remaining || 0) || 'none';
    let free;
    if (d.missing) free = '<span class="xp-drive-free faint">Introuvable : disque débranché ou hors ligne ?</span>';
    else if (d.free != null) free = `<span class="xp-drive-free"><b>${formatSize(d.free)}</b> libres</span>`;
    else free = '<span class="xp-drive-free faint">Espace libre inconnu</span>';
    const meta = [];
    if (u) meta.push(`${icon('layers')}<span>${plural(u.count, 'torrent')} · ${formatSize(u.done)}</span>`);
    if (u?.remaining > 0) meta.push(`${icon('arrowDown')}<span>${formatSize(u.remaining)} à télécharger</span>`);
    if (!u && !d.missing) meta.push(`<span>Aucun torrent sur ce disque</span>`);
    const short = d.free != null && u?.remaining > d.free;
    return `<div class="xp-drive lvl-${level}${d.missing ? ' missing' : ''}${this.isSelected(d.root) ? ' selected' : ''}" data-path="${esc(d.root)}" data-kind="drive" title="${esc(d.root)} — double-clic pour ouvrir">
      <span class="xp-drive-ico">${driveIcon(d)}</span>
      <div class="xp-drive-body">
        <div class="xp-drive-name"><b>${esc(this.driveLabel(d.root))}</b>${d.isDefault ? '<span class="chip accent">Par défaut</span>' : ''}</div>
        ${free}
        ${meta.length ? `<div class="xp-drive-meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>` : ''}
        ${short ? `<span class="chip err">${icon('alert')}Pas assez de place pour finir les téléchargements</span>` : ''}
      </div>
      <button type="button" class="btn btn-ghost btn-xs xp-rename" data-rename="${esc(d.root)}" title="Renommer ce disque">${icon('pencil')}</button>
    </div>`;
  }

  renderStatus() {
    const st = this.st;
    let left = '';
    if (st.path === null) {
      if (st.storage) left = plural(st.storage.drives.length, 'disque');
    } else if (!st.loading && !st.error) {
      const shown = this.visibleEntries();
      const dirs = shown.filter((e) => e.type === 'dir').length;
      const files = shown.length - dirs;
      const size = shown.reduce((sum, e) => sum + (e.type === 'file' ? e.size || 0 : 0), 0);
      left = `${plural(shown.length, 'élément')} · ${plural(dirs, 'dossier')}, ${plural(files, 'fichier')}${size ? ` (${formatSize(size)})` : ''}`;
      const hidden = st.showFiles ? 0 : st.entries.filter((e) => e.type === 'file').length;
      if (hidden) left += ` · ${hidden} masqué${hidden > 1 ? 's' : ''}`;
      const sel = st.selected && shown.find((e) => samePath(e.path, st.selected));
      if (sel?.type === 'file' && sel.size != null) left += ` · sélection : ${formatSize(sel.size)}`;
    }
    this.$('.xp-count').textContent = left;

    const d = st.path ? driveFor(st.storage?.drives, st.path) : null;
    this.$('.xp-drive-status').textContent = d
      ? `${this.driveLabel(d.root)}${d.free != null ? ` · ${formatSize(d.free)} libres` : ''}`
      : '';
  }

  renderFoot() {
    if (!this.pick) return;
    const t = this.target();
    const d = t ? driveFor(this.st.storage?.drives, t) : null;
    let space = '';
    if (d?.free != null) {
      const short = this.need > d.free;
      space = `<span class="xp-picked-free${short ? ' err' : ''}">${icon(short ? 'alert' : 'hardDrive')}${formatSize(d.free)} libres${short ? ` : il faut ${formatSize(this.need)}` : ''}</span>`;
    }
    this.$('.xp-picked').innerHTML = `<span class="faint">Dossier :</span><b title="${esc(t || '')}">${esc(t || 'aucun')}</b>${space}`;
    this.$('[data-act="choose"]').disabled = !t;
  }
}

// Fenêtre de choix d'un dossier. Renvoie le chemin choisi, ou null.
export function pickFolder({ title = "Choisir l'emplacement", ...opts }) {
  return new Promise((resolve) => {
    let host = '';
    try { host = new URL(opts.cfg.serverUrl).host; } catch { /* adresse invalide */ }
    const backdrop = document.createElement('div');
    backdrop.className = 'xp-backdrop';
    backdrop.innerHTML = `
      <div class="xp-window" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
        <header class="xp-title">
          <span class="tile">${icon('folderOpen')}</span>
          <div class="grow"><strong>${esc(title)}</strong><span class="faint small">Dossiers du serveur qBittorrent${host ? ` · ${esc(host)}` : ''}</span></div>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-close title="Fermer (Échap)">${icon('x')}</button>
        </header>
        <div class="xp-host"></div>
      </div>`;
    document.body.append(backdrop);

    let explorer;
    const finish = (value) => {
      explorer.destroy();
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 140);
      resolve(value);
    };
    explorer = new Explorer(backdrop.querySelector('.xp-host'), {
      ...opts, pick: true, onChoose: finish, onCancel: () => finish(null),
    });
    backdrop.querySelector('[data-close]').addEventListener('click', () => finish(null));
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(null); });
    // Le focus quitte le bouton qui a ouvert la fenêtre (sinon Entrée la rouvrirait).
    backdrop.querySelector('.xp-window').focus();
  });
}
