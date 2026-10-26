// Explorateur de dossiers du serveur, façon Explorateur de fichiers de Windows.
//
//   const path = await openExplorer({ client, initial: 'B:\\Films', quick: [...] });
//
// Renvoie le chemin choisi, ou null si l'utilisateur annule.
import { icon } from '../lib/icons.js';
import { esc } from '../lib/ui.js';
import { formatSize } from '../lib/torrent.js';
import { parentPath, joinPath, safeFolderName, isWindowsPath } from '../lib/clients/base.js';

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const VIEW_KEY = 'qbc-explorer-view';

const fmtDate = (s) => (s ? new Date(s * 1000).toLocaleString('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '');

function driveLabel(d) {
  const m = /^([a-zA-Z]):/.exec(d.path);
  return m ? `Disque local (${m[1].toUpperCase()}:)` : d.label || d.path;
}

// Libellé lisible d'un segment de chemin pour le fil d'Ariane.
function crumbs(path) {
  if (!path) return [];
  let acc = '';
  if (isWindowsPath(path)) {
    return path.split(/[\\/]+/).filter(Boolean).map((p, i) => {
      acc = i === 0 ? `${p}\\` : joinPath(acc, p);
      return { label: i === 0 ? p.toUpperCase() : p, path: acc };
    });
  }
  return [{ label: '/', path: '/' }, ...path.split('/').filter(Boolean).map((p) => {
    acc = `${acc}/${p}`;
    return { label: p, path: acc };
  })];
}

export function openExplorer({ client, initial = '', quick = [], title = 'Choisir un dossier' }) {
  return new Promise((resolve) => {
    const browse = Boolean(client?.caps?.browse);
    const host = (() => { try { return new URL(client.base).host; } catch { return ''; } })();
    const st = {
      path: null, // null = « Ce PC »
      back: [],
      fwd: [],
      entries: [],
      selected: null,
      filter: '',
      view: (() => { try { return localStorage.getItem(VIEW_KEY) || 'list'; } catch { return 'list'; } })(),
      drives: null,
      error: null,
      loading: false,
      created: new Map(), // dossiers créés ici, qui n'existent pas encore sur le serveur
      free: null,
    };

    const root = document.createElement('div');
    root.className = 'xp-backdrop';
    root.innerHTML = `
      <div class="xp-window" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header class="xp-title">
          <span class="xp-title-ico">${icon('folderOpen')}</span>
          <div class="grow"><strong>${esc(title)}</strong><span class="faint small">${esc(client?.label || '')}${host ? ` · ${esc(host)}` : ''}</span></div>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="close" title="Fermer">${icon('x')}</button>
        </header>
        <div class="xp-toolbar">
          <div class="xp-nav">
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="back" title="Précédent">${icon('arrowLeft')}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="fwd" title="Suivant">${icon('arrowRight')}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="up" title="Dossier parent">${icon('arrowUp')}</button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="refresh" title="Actualiser">${icon('refresh')}</button>
          </div>
          <div class="xp-address" data-act="edit-address">
            <div class="xp-crumbs"></div>
            <input class="xp-address-input" type="text" spellcheck="false" hidden>
          </div>
          <div class="field-icon xp-search">
            <i data-icon="search">${icon('search')}</i>
            <input class="input" type="search" placeholder="Rechercher" spellcheck="false">
          </div>
          <div class="seg xp-views">
            <label title="Liste"><input type="radio" name="xp-view" value="list"><span>${icon('list')}</span></label>
            <label title="Grandes icônes"><input type="radio" name="xp-view" value="grid"><span>${icon('grid')}</span></label>
          </div>
        </div>
        <div class="xp-body">
          <nav class="xp-side"></nav>
          <section class="xp-main"></section>
        </div>
        <footer class="xp-foot">
          <button type="button" class="btn btn-sm" data-act="newfolder">${icon('folderPlus')}Nouveau dossier</button>
          <div class="xp-picked"><span class="faint">Dossier :</span> <b class="xp-picked-path"></b><span class="xp-picked-free faint"></span></div>
          <button type="button" class="btn btn-ghost" data-act="close">Annuler</button>
          <button type="button" class="btn btn-primary" data-act="choose">${icon('check')}Sélectionner</button>
        </footer>
      </div>`;
    document.body.append(root);
    root.querySelector(`input[name="xp-view"][value="${st.view}"]`).checked = true;

    const $ = (s) => root.querySelector(s);
    const main = $('.xp-main');
    const side = $('.xp-side');

    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      root.classList.add('closing');
      setTimeout(() => root.remove(), 120);
      resolve(value);
    };

    const target = () => st.selected || st.path;

    function renderSide() {
      const isCur = (p) => st.path && p && st.path.replace(/[\\/]+$/, '').toLowerCase() === p.replace(/[\\/]+$/, '').toLowerCase();
      const quickHtml = quick.filter((q) => q.path).map((q) => `
        <button type="button" class="xp-side-item${isCur(q.path) ? ' active' : ''}" data-path="${esc(q.path)}" title="${esc(q.path)}">
          ${icon(q.icon || 'folder')}<span>${esc(q.label)}</span>
        </button>`).join('');
      const drives = st.drives === null
        ? '<div class="xp-side-loading"><span class="spinner"></span></div>'
        : st.drives.map((d) => `
          <button type="button" class="xp-side-item${isCur(d.path) ? ' active' : ''}" data-path="${esc(d.path)}">
            ${icon('hardDrive')}<span>${esc(driveLabel(d))}</span>
          </button>`).join('');
      side.innerHTML = `
        ${quickHtml ? `<div class="xp-side-group">Accès rapide</div>${quickHtml}` : ''}
        <div class="xp-side-group">Serveur</div>
        <button type="button" class="xp-side-item${st.path === null ? ' active' : ''}" data-path="">${icon('monitor')}<span>Ce PC</span></button>
        ${browse ? drives : ''}`;
    }

    function entriesView() {
      const q = st.filter.toLowerCase();
      const created = (st.created.get(st.path) || []).map((name) => ({ name, path: joinPath(st.path, name), created: true }));
      const all = [...created, ...st.entries.filter((e) => !created.some((c) => c.name === e.name))]
        .filter((e) => !q || e.name.toLowerCase().includes(q))
        .sort((a, b) => collator.compare(a.name, b.name));
      return all;
    }

    function renderMain() {
      if (st.loading) {
        main.innerHTML = '<div class="xp-empty"><span class="spinner"></span><p>Chargement…</p></div>';
        return;
      }
      // « Ce PC » : lecteurs et accès rapide.
      if (st.path === null) {
        const tiles = (list, kind) => list.map((d) => `
          <button type="button" class="xp-tile ${kind}${st.selected === d.path ? ' selected' : ''}" data-path="${esc(d.path)}" title="${esc(d.path)}">
            <span class="xp-tile-ico">${icon(kind === 'drive' ? 'hardDrive' : d.icon || 'folder')}</span>
            <span class="xp-tile-text"><b>${esc(kind === 'drive' ? driveLabel(d) : d.label)}</b>
            <span class="faint small">${kind === 'drive' ? (d.free != null ? `${formatSize(d.free)} libres` : esc(d.path)) : esc(d.path)}</span></span>
          </button>`).join('');
        main.innerHTML = `
          ${browse ? `<h3 class="xp-section">Lecteurs</h3>
            <div class="xp-tiles">${st.drives === null ? '<span class="spinner"></span>' : st.drives.length ? tiles(st.drives, 'drive') : '<p class="faint">Aucun lecteur trouvé.</p>'}</div>`
            : `<div class="xp-notice">${icon('info')}<p>${esc(client?.label || 'Ce client')} ne permet pas de parcourir les dossiers du serveur. Choisis un emplacement ci-dessous ou tape un chemin dans la barre d'adresse.</p></div>`}
          ${quick.length ? `<h3 class="xp-section">Accès rapide</h3><div class="xp-tiles">${tiles(quick.filter((q) => q.path), 'quick')}</div>` : ''}`;
        return;
      }
      if (!browse) {
        const created = st.created.get(st.path) || [];
        main.innerHTML = `<div class="xp-empty">${icon('folderSearch')}
          <p>${esc(client?.label || 'Ce client')} ne permet pas d'afficher le contenu de ce dossier. Le chemin sera utilisé tel quel${created.length ? ', avec le nouveau dossier choisi' : ''}.</p></div>`;
        return;
      }
      if (st.error) {
        main.innerHTML = `<div class="xp-empty">${icon(st.error.code === 'NOT_FOUND' ? 'folderPlus' : 'alert')}
          <p>${st.error.code === 'NOT_FOUND' ? "Ce dossier n'existe pas encore : il sera créé au premier téléchargement." : esc(st.error.message)}</p></div>`;
        return;
      }
      const list = entriesView();
      if (!list.length) {
        main.innerHTML = `<div class="xp-empty">${icon('folderOpen')}<p>${st.filter ? 'Aucun dossier ne correspond à la recherche.' : 'Ce dossier ne contient aucun sous-dossier.'}</p></div>`;
        return;
      }
      if (st.view === 'grid') {
        main.innerHTML = `<div class="xp-grid">${list.map((e) => `
          <button type="button" class="xp-cell${st.selected === e.path ? ' selected' : ''}" data-path="${esc(e.path)}" title="${esc(e.name)}">
            <span class="xp-cell-ico">${icon('folder')}</span>
            <span class="xp-cell-name">${esc(e.name)}</span>
            ${e.created ? '<span class="chip accent xp-new">nouveau</span>' : ''}
          </button>`).join('')}</div>`;
      } else {
        main.innerHTML = `
          <div class="xp-list">
            <div class="xp-row xp-head"><span>Nom</span><span>Modifié le</span><span>Type</span></div>
            ${list.map((e) => `
              <button type="button" class="xp-row${st.selected === e.path ? ' selected' : ''}" data-path="${esc(e.path)}" title="${esc(e.path)}">
                <span class="xp-name">${icon('folder')}<span>${esc(e.name)}</span>${e.created ? '<span class="chip accent xp-new">nouveau</span>' : ''}</span>
                <span class="faint">${e.created ? 'sera créé' : fmtDate(e.modified)}</span>
                <span class="faint">Dossier de fichiers</span>
              </button>`).join('')}
          </div>`;
      }
    }

    function renderBar() {
      const list = crumbs(st.path);
      $('.xp-crumbs').innerHTML = `<button type="button" class="xp-crumb" data-path="">${icon('monitor')}<span>Ce PC</span></button>${
        list.map((c) => `<span class="xp-sep">${icon('chevronRight')}</span><button type="button" class="xp-crumb" data-path="${esc(c.path)}">${esc(c.label)}</button>`).join('')}`;
      $('[data-act="back"]').disabled = !st.back.length;
      $('[data-act="fwd"]').disabled = !st.fwd.length;
      $('[data-act="up"]').disabled = st.path === null;
      $('[data-act="newfolder"]').disabled = st.path === null;
      const t = target();
      $('.xp-picked-path').textContent = t || 'aucun';
      $('.xp-picked-path').title = t || '';
      $('.xp-picked-free').textContent = st.free != null && t === st.path ? ` · ${formatSize(st.free)} libres` : '';
      $('[data-act="choose"]').disabled = !t;
    }

    function render() {
      renderSide();
      renderBar();
      renderMain();
    }

    async function load(path, { push = true } = {}) {
      if (push && st.path !== path) {
        st.back.push(st.path);
        st.fwd = [];
      }
      st.path = path || null;
      st.selected = null;
      st.filter = '';
      $('.xp-search input').value = '';
      st.error = null;
      st.entries = [];
      st.free = null;
      if (st.path === null || !browse) {
        st.loading = false;
        render();
        return;
      }
      st.loading = true;
      render();
      const token = (load.token = (load.token || 0) + 1);
      try {
        const entries = await client.listDir(st.path);
        if (token !== load.token) return;
        st.entries = entries;
      } catch (e) {
        if (token !== load.token) return;
        st.error = e;
      }
      st.loading = false;
      render();
      client.freeSpace?.(st.path).then((free) => {
        if (token === load.token && free != null) {
          st.free = free;
          renderBar();
        }
      }).catch(() => {});
    }

    function editAddress(on) {
      const input = $('.xp-address-input');
      $('.xp-crumbs').hidden = on;
      input.hidden = !on;
      if (on) {
        input.value = st.path || '';
        input.focus();
        input.select();
      }
    }

    function onKey(e) {
      if (e.target.matches?.('.xp-address-input')) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Backspace' && !e.target.matches?.('input')) {
        e.preventDefault();
        const p = parentPath(st.path || '');
        if (st.path !== null) load(p);
      } else if (e.key === 'Enter' && !e.target.matches?.('input, button')) {
        if (st.selected) load(st.selected);
      }
    }
    document.addEventListener('keydown', onKey, true);

    root.addEventListener('mousedown', (e) => { if (e.target === root) finish(null); });

    root.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const pathEl = e.target.closest('[data-path]');
      if (pathEl && (pathEl.closest('.xp-side') || pathEl.closest('.xp-crumbs'))) {
        e.stopPropagation();
        load(pathEl.dataset.path || null);
        return;
      }
      if (pathEl && pathEl.closest('.xp-main')) {
        st.selected = pathEl.dataset.path;
        main.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
        pathEl.classList.add('selected');
        renderBar();
        return;
      }
      switch (act) {
        case 'close': finish(null); break;
        case 'choose': if (target()) finish(target()); break;
        case 'back': if (st.back.length) { st.fwd.push(st.path); load(st.back.pop(), { push: false }); } break;
        case 'fwd': if (st.fwd.length) { st.back.push(st.path); load(st.fwd.pop(), { push: false }); } break;
        case 'up': if (st.path !== null) load(parentPath(st.path)); break;
        case 'refresh':
          if (st.path === null && browse) { st.drives = null; renderSide(); loadDrives(); }
          load(st.path, { push: false });
          break;
        case 'edit-address': if (!e.target.closest('.xp-crumb')) editAddress(true); break;
        case 'newfolder': {
          const name = safeFolderName(prompt('Nom du nouveau dossier :') || '');
          if (!name || st.path === null) break;
          const list = st.created.get(st.path) || [];
          if (!list.includes(name)) list.push(name);
          st.created.set(st.path, list);
          st.selected = joinPath(st.path, name);
          render();
          break;
        }
        default:
      }
    });

    main.addEventListener('dblclick', (e) => {
      const el = e.target.closest('[data-path]');
      if (el) load(el.dataset.path);
    });

    $('.xp-address-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = e.target.value.trim();
        editAddress(false);
        if (value) load(value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        editAddress(false);
      }
    });
    $('.xp-address-input').addEventListener('blur', () => editAddress(false));

    $('.xp-search input').addEventListener('input', (e) => {
      st.filter = e.target.value.trim();
      renderMain();
    });

    $('.xp-views').addEventListener('change', (e) => {
      st.view = e.target.value;
      try { localStorage.setItem(VIEW_KEY, st.view); } catch { /* préférence non mémorisée */ }
      renderMain();
    });

    async function loadDrives() {
      try {
        st.drives = await client.roots();
      } catch {
        st.drives = [];
      }
      render();
    }

    if (browse) loadDrives();
    else st.drives = [];
    load(initial || null, { push: false });
  });
}
