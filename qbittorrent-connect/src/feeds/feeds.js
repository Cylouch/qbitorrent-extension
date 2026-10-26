import { getConfig, setConfig } from '../lib/config.js';
import { fetchIndexer, releaseTags, suggestName, isTorznab } from '../lib/feeds.js';
import { loadPosterCache, posterQuery, cachedPoster, findPoster, parseRelease, prettyTitle } from '../lib/posters.js';
import { formatSize, isMagnet } from '../lib/torrent.js';
import { Qbt } from '../lib/qbt.js';
import { icon } from '../lib/icons.js';
import { $, esc, hydrateIcons, toast } from '../lib/ui.js';
import { initTheme, bindThemeButton } from '../lib/theme.js';

// Dernières sorties gardées entre deux visites (feedCache) et sorties déjà vues
// (feedSeen) : ce qui n'était pas là à la visite précédente est marqué « Nouveau ».
const CACHE_KEY = 'feedCache';
const SEEN_KEY = 'feedSeen';
const KEEP_ITEMS = 100;
const STALE = 5 * 60 * 1000;
const AUTO_REFRESH = 10 * 60 * 1000;
const QBT_REFRESH = 15000;

const TYPES = {
  movie: { label: 'Film', icon: 'film' },
  tv: { label: 'Série', icon: 'tv' },
  other: { label: 'Autre', icon: 'file' },
};
const KIND_LABEL = { torznab: 'Torznab', rss: 'RSS', atom: 'Atom' };

const URL_HINT = "L'adresse du flux RSS de l'indexeur. Avec la page d'accueil d'un site, l'extension cherche son flux.";
const PRESETS = {
  c411: { name: 'C411', url: 'https://c411.org/api/torznab', hint: 'Colle ta clé API C411 (dans ton profil sur le site).', focus: 'ixKey' },
  jackett: {
    url: 'http://localhost:9117/api/v2.0/indexers/NOM/results/torznab/',
    hint: "Dans Jackett, « Copy Torznab Feed » sur l'indexeur donne l'adresse ; la clé API est en haut de la page.",
    select: 'NOM',
  },
  prowlarr: {
    url: 'http://localhost:9696/1/',
    hint: "Dans Prowlarr, le numéro de l'indexeur est dans son adresse ; la clé API est dans Settings → General.",
    select: '1',
  },
};

const state = {
  cfg: null,
  cache: {}, // id → { at, items, title, site, kind, error, errorAt }
  seenBefore: {}, // id → Set des sorties vues à la visite précédente
  seenNow: {}, // id → guids à mémoriser pour la prochaine visite
  loading: new Set(),
  inQbt: new Set(),
  qbtAt: 0,
  query: '',
  editing: null,
  lastTest: null,
};

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto', style: 'short' });
const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short' });

function ago(ts) {
  if (!ts) return '';
  const s = Math.min(0, Math.round((ts - Date.now()) / 1000));
  if (s > -60) return "à l'instant";
  if (s > -3600) return rtf.format(Math.round(s / 60), 'minute');
  if (s > -86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (s > -86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

const safeHttp = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const normName = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\d*\./, ''); } catch { return ''; } };
const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function favicon(site) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', site);
  url.searchParams.set('size', '32');
  return url.href;
}

const indexers = () => state.cfg.indexers || [];
const findIndexer = (id) => indexers().find((ix) => ix.id === id);

function isNew(id, item) {
  const seen = state.seenBefore[id];
  return Boolean(seen) && !seen.has(item.guid);
}

// Recherche tolérante : « the bear » trouve « The.Bear.S04E01 ».
function matches(title, query) {
  if (!query) return true;
  const t = title.toLowerCase().replace(/[._-]+/g, ' ');
  return query.split(/\s+/).every((w) => t.includes(w));
}

function visible(items) {
  const f = state.cfg.feedFilter;
  const q = state.query.toLowerCase().replace(/[._-]+/g, ' ').trim();
  return items.filter((i) => (f === 'all' || i.type === f) && matches(i.title, q));
}

// --- Affiches ---------------------------------------------------------------------

const memo = (fn) => {
  const cache = new Map();
  return (key, ...args) => {
    if (!cache.has(key)) cache.set(key, fn(...args));
    return cache.get(key);
  };
};
const releaseOf = memo(parseRelease);
const queryOf = memo(posterQuery);
const queryFor = (it) => queryOf(`${it.imdbId}|${it.type}|${it.title}`, it);

// Affiche connue tout de suite (flux ou cache), sinon cherchée en arrière-plan :
// les vignettes qui l'attendent (data-pk) sont remplies à son arrivée.
function posterOf(it) {
  if (safeHttp(it.poster)) return { url: it.poster, key: '' };
  if (!state.cfg.feedPosters) return { url: '', key: '' };
  const q = queryFor(it);
  if (!q) return { url: '', key: '' };
  const known = cachedPoster(q);
  if (known === undefined) findPoster(q).then((url) => { if (url) fillPosters(q.key, url); });
  return { url: known || '', key: q.key };
}

const imgHtml = (url) => `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">`;

function posterHtml(it, cls) {
  const { url, key } = posterOf(it);
  const type = TYPES[it.type] || TYPES.other;
  return `<span class="${cls}${url ? ' has-img' : ''}" data-type="${esc(it.type)}"${key ? ` data-pk="${esc(key)}"` : ''}>${url ? imgHtml(url) : icon(type.icon)}</span>`;
}

function fillPosters(key, url) {
  for (const el of document.querySelectorAll(`[data-pk="${CSS.escape(key)}"]:not(.has-img)`)) {
    el.innerHTML = imgHtml(url);
    el.classList.add('has-img');
  }
}

// Image introuvable ou bloquée : retour à l'icône du type.
function onImageError(e) {
  const holder = e.target.tagName === 'IMG' && e.target.closest('[data-type]');
  if (!holder) return;
  holder.classList.remove('has-img');
  holder.innerHTML = icon((TYPES[holder.dataset.type] || TYPES.other).icon);
}

// --- Rendu ----------------------------------------------------------------------

function sendButton(it, ix, cls = '') {
  const canSend = Boolean(state.cfg.serverUrl) && (isMagnet(it.torrentUrl) || Boolean(safeHttp(it.torrentUrl)));
  return canSend
    ? `<button type="button" class="btn btn-ghost btn-icon btn-sm r-send ${cls}" data-ix="${esc(ix.id)}" data-guid="${esc(it.guid)}" title="Envoyer à qBittorrent">${icon('download')}</button>`
    : '';
}

const haveMark = (it) => (state.inQbt.has(normName(it.title)) ? `<span class="r-have" title="Déjà dans qBittorrent">${icon('checkCircle')}</span>` : '');

// Vignette de la vue « Affiches » : titre lisible sous l'affiche, nom complet de
// la release, taille et sources dans l'infobulle.
function tileHtml(it, ix) {
  const info = releaseOf(it.title, it.title);
  const link = safeHttp(it.link);
  const name = info ? prettyTitle(info.title) : it.title;
  const sub = [info?.code || info?.year || '', it.date ? ago(it.date) : ''].filter(Boolean).join(' · ');
  const tip = [
    it.title,
    [it.size ? formatSize(it.size) : '', it.seeders != null ? `${it.seeders} sources, ${it.leechers ?? 0} clients` : ''].filter(Boolean).join(' · '),
    link ? 'Cliquer pour ouvrir la page du torrent' : '',
  ].filter(Boolean).join('\n');
  const tags = releaseTags(it.title).map((t) => `<span class="tag">${t}</span>`).join('');
  return `<li class="ptile k-${it.type}${link ? ' has-link' : ''}" title="${esc(tip)}">
    <div class="p-frame">
      ${posterHtml(it, 'p-art')}
      ${isNew(ix.id, it) ? '<span class="tag new p-new">Nouveau</span>' : ''}
      <div class="p-tags">${tags}</div>
      <div class="p-acts">${haveMark(it)}${sendButton(it, ix, 'p-send')}</div>
    </div>
    ${link
    ? `<a class="p-title" href="${esc(link)}" target="_blank" rel="noreferrer noopener">${esc(name)}</a>`
    : `<span class="p-title">${esc(name)}</span>`}
    <span class="p-sub">${esc(sub)}</span>
  </li>`;
}

function rowHtml(it, ix, showIndexer = false) {
  const link = safeHttp(it.link);
  const fresh = isNew(ix.id, it);

  const info = [];
  if (showIndexer) info.push(`<span class="r-ix">${esc(ix.name)}</span>`);
  if (it.size) info.push(`<span>${formatSize(it.size)}</span>`);
  if (it.seeders != null) {
    info.push(`<span class="r-peers" title="${it.seeders} sources, ${it.leechers ?? 0} clients">`
      + `<span class="up">${icon('arrowUp')}${it.seeders}</span><span>${icon('arrowDown')}${it.leechers ?? 0}</span></span>`);
  }
  if (it.date) info.push(`<time title="${esc(dateFmt.format(it.date))}">${esc(ago(it.date))}</time>`);

  const tags = [
    fresh ? '<span class="tag new">Nouveau</span>' : '',
    ...releaseTags(it.title).map((t) => `<span class="tag">${t}</span>`),
  ].join('');
  const title = link
    ? `<a class="r-title" href="${esc(link)}" target="_blank" rel="noreferrer noopener" title="${esc(it.title)}\nOuvrir la page du torrent">${esc(it.title)}</a>`
    : `<span class="r-title" title="${esc(it.title)}">${esc(it.title)}</span>`;

  return `<li class="rel k-${it.type}${link ? ' has-link' : ''}">
    ${posterHtml(it, 'r-ico')}
    <div class="r-main">
      ${title}
      <div class="r-meta">${tags}<span class="r-info">${info.join('<span class="sep">·</span>')}</span></div>
    </div>
    <div class="r-acts">${haveMark(it)}${sendButton(it, ix)}</div>
  </li>`;
}

function emptyHtml(ico, text, action = '') {
  return `<div class="ix-msg">${icon(ico)}<span>${esc(text)}</span>${action}</div>`;
}

function cardHtml(ix) {
  const c = state.cache[ix.id] || {};
  const loading = state.loading.has(ix.id);
  const all = c.items || [];
  const items = visible(all);
  const shown = items.slice(0, state.cfg.feedCount);
  const newCount = all.filter((i) => isNew(ix.id, i)).length;
  const site = safeHttp(c.site) || originOf(ix.url);

  let dot = 'ok';
  let status = c.at ? `actualisé ${ago(c.at)}` : '';
  if (loading) { dot = 'wait'; status = 'actualisation…'; }
  else if (c.error) { dot = 'err'; status = c.at ? `échec ${ago(c.errorAt)}` : 'erreur'; }
  else if (!c.at) dot = '';
  const sub = [hostOf(site), KIND_LABEL[c.kind] || (isTorznab(ix) ? 'Torznab' : ''), status].filter(Boolean).join(' · ');

  let body;
  if (c.error && !all.length) {
    body = emptyHtml('alert', c.error, `<button type="button" class="btn btn-sm" data-act="edit">${icon('pencil')}Modifier l'adresse</button>`);
  } else if (!c.items) {
    body = state.cfg.feedView === 'posters'
      ? `<div class="pgrid">${'<div class="sk sk-tile"></div>'.repeat(6)}</div>`
      : `<div class="rlist sk-list">${'<div class="sk"></div>'.repeat(5)}</div>`;
  } else if (!shown.length) {
    body = emptyHtml(state.query ? 'search' : 'inbox', all.length ? 'Aucune sortie pour ce filtre' : 'Aucune sortie dans ce flux');
  } else if (state.cfg.feedView === 'posters') {
    body = `<ul class="pgrid">${shown.map((it) => tileHtml(it, ix)).join('')}</ul>`;
  } else {
    body = `<ul class="rlist">${shown.map((it) => rowHtml(it, ix)).join('')}</ul>`;
    if (items.length > shown.length) body += `<p class="more">${plural(items.length - shown.length, 'autre sortie')} dans le flux</p>`;
  }
  const warn = c.error && all.length
    ? `<div class="banner error ix-warn">${icon('alert')}<span class="grow">${esc(c.error)}</span></div>`
    : '';

  return `<section class="card ixcard" data-id="${esc(ix.id)}">
    <header class="ix-head">
      <span class="ix-fav">${site ? `<img src="${esc(favicon(site))}" alt="">` : icon('globe')}</span>
      <div class="ix-titles">
        <h2><span class="ix-name">${esc(ix.name)}</span>${newCount ? `<span class="chip accent">${newCount} nouveau${newCount > 1 ? 'x' : ''}</span>` : ''}</h2>
        <p>${dot ? `<span class="dot ${dot}"></span>` : ''}<span>${esc(sub)}</span></p>
      </div>
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="refresh" title="Actualiser"${loading ? ' disabled' : ''}>${loading ? '<span class="spinner"></span>' : icon('refresh')}</button>
      ${site ? `<a class="btn btn-ghost btn-icon btn-sm" href="${esc(site)}" target="_blank" rel="noreferrer noopener" title="Ouvrir ${esc(hostOf(site))}">${icon('external')}</a>` : ''}
      <button type="button" class="btn btn-ghost btn-icon btn-sm" data-act="edit" title="Modifier ou supprimer">${icon('pencil')}</button>
    </header>
    ${warn}
    ${body}
  </section>`;
}

function timelineHtml() {
  const rows = [];
  for (const ix of indexers()) {
    for (const it of visible(state.cache[ix.id]?.items || []).slice(0, state.cfg.feedCount)) rows.push({ it, ix });
  }
  rows.sort((a, b) => (b.it.date || 0) - (a.it.date || 0));
  if (rows.length) return rows.map(({ it, ix }) => rowHtml(it, ix, true)).join('');
  const busy = state.loading.size > 0;
  return `<li>${emptyHtml(busy ? 'clock' : state.query ? 'search' : 'inbox', busy ? 'Lecture des indexeurs…' : 'Aucune sortie pour ce filtre')}</li>`;
}

function renderToolbar() {
  const busy = state.loading.size > 0;
  $('refreshAll').disabled = busy;
  $('refreshAll').innerHTML = `${busy ? '<span class="spinner"></span>' : icon('refresh')}Actualiser`;
  const last = Math.max(0, ...indexers().map((ix) => state.cache[ix.id]?.at || 0));
  $('updated').textContent = busy ? 'Actualisation…' : last ? `Actualisé ${ago(last)}` : '';
}

function render() {
  const has = indexers().length > 0;
  $('welcome').hidden = has;
  $('toolbar').hidden = !has;
  const timeline = state.cfg.feedView === 'timeline';
  $('grid').hidden = !has || timeline;
  $('timeline').hidden = !has || !timeline;
  $('grid').classList.toggle('pv', state.cfg.feedView === 'posters');
  document.body.classList.toggle('with-posters', Boolean(state.cfg.feedPosters));
  if (has && timeline) $('tlist').innerHTML = timelineHtml();
  else $('grid').innerHTML = has ? indexers().map(cardHtml).join('') : '';
  renderToolbar();
}

// Une seule carte à redessiner pendant les actualisations, sauf en vue chronologique.
function renderIndexer(id) {
  const ix = findIndexer(id);
  const card = document.querySelector(`.ixcard[data-id="${CSS.escape(id)}"]`);
  if (!ix || !card || state.cfg.feedView === 'timeline') { render(); return; }
  card.outerHTML = cardHtml(ix);
  renderToolbar();
}

// --- Données -------------------------------------------------------------------

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ids = new Set(indexers().map((ix) => ix.id));
    const keep = (obj) => Object.fromEntries(Object.entries(obj).filter(([id]) => ids.has(id)));
    chrome.storage.local.set({ [CACHE_KEY]: keep(state.cache), [SEEN_KEY]: keep(state.seenNow) });
  }, 400);
}

async function refresh(ix) {
  if (state.loading.has(ix.id)) return;
  state.loading.add(ix.id);
  renderIndexer(ix.id);
  try {
    store(ix, await fetchIndexer(ix));
  } catch (e) {
    state.cache[ix.id] = { ...state.cache[ix.id], error: e.message, errorAt: Date.now() };
  }
  state.loading.delete(ix.id);
  saveSoon();
  renderIndexer(ix.id);
}

function store(ix, result) {
  const items = result.items.slice(0, KEEP_ITEMS);
  state.cache[ix.id] = { at: Date.now(), items, title: result.title, site: result.site, kind: result.kind };
  state.seenNow[ix.id] = items.map((i) => i.guid);
}

function refreshAll(onlyStale = false) {
  const now = Date.now();
  for (const ix of indexers()) {
    if (onlyStale && now - (state.cache[ix.id]?.at || 0) < STALE) continue;
    refresh(ix);
  }
  renderToolbar();
}

async function loadQbt(force = false) {
  if (!state.cfg.serverUrl || (!force && Date.now() - state.qbtAt < QBT_REFRESH)) return;
  state.qbtAt = Date.now();
  try {
    const list = await new Qbt(state.cfg).torrents();
    state.inQbt = new Set(list.map((t) => normName(t.name)));
    render();
  } catch { /* serveur hors ligne : pas de repère « déjà ajouté » */ }
}

async function send(btn) {
  const it = state.cache[btn.dataset.ix]?.items.find((i) => i.guid === btn.dataset.guid);
  if (!it) return;
  const data = isMagnet(it.torrentUrl)
    ? { kind: 'magnet', url: it.torrentUrl }
    : { kind: 'url', url: it.torrentUrl, referrer: safeHttp(it.link) || undefined };
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'open-add', data });
    if (!res?.ok) throw new Error(res?.error || 'pas de réponse');
    if (state.cfg.addMode === 'direct') {
      toast('Envoyé à qBittorrent', 'ok');
      setTimeout(() => loadQbt(true), 2500);
    }
  } catch (e) {
    toast(`Envoi impossible : ${e.message}`, 'error');
  }
  btn.disabled = false;
  btn.innerHTML = icon('download');
}

// --- Fenêtre « Ajouter un indexeur » --------------------------------------------

function showTest(kind, title, text = '') {
  const ico = kind === 'info' ? '<span class="spinner"></span>' : icon(kind === 'ok' ? 'checkCircle' : 'alert');
  $('testResult').className = `banner ${kind} test-result`;
  $('testResult').innerHTML = `${ico}<div class="grow"><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  $('testResult').hidden = false;
}

function readForm() {
  let url = $('ixUrl').value.trim();
  if (url && !/^[a-z][\w+.-]*:\/\//i.test(url)) url = `https://${url}`;
  return {
    url,
    name: $('ixName').value.trim(),
    apikey: $('ixKey').value.trim(),
    content: document.querySelector('#ixContent input:checked').value,
  };
}

const formKey = ({ url, apikey, content }) => JSON.stringify([url, apikey, content]);

function validUrl(url) {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

function openDialog(ix = null) {
  state.editing = ix?.id || null;
  state.lastTest = null;
  $('dialogTitle').textContent = ix ? "Modifier l'indexeur" : 'Ajouter un indexeur';
  $('ixUrl').value = ix?.url || '';
  $('ixName').value = ix?.name || '';
  $('ixKey').value = ix?.apikey || '';
  $('ixKey').type = 'password';
  $('keyToggle').innerHTML = icon('eye');
  document.querySelector(`#ixContent input[value="${ix?.content === 'all' ? 'all' : 'media'}"]`).checked = true;
  $('ixDelete').hidden = !ix;
  $('testResult').hidden = true;
  $('urlHint').textContent = URL_HINT;
  $('dialog').showModal();
  $('ixUrl').focus();
}

async function testForm() {
  const data = readForm();
  if (!validUrl(data.url)) {
    showTest('error', 'Adresse invalide', 'Indique une adresse qui commence par http:// ou https://.');
    $('ixUrl').focus();
    return null;
  }
  $('ixTest').disabled = true;
  showTest('info', 'Lecture du flux…', data.url);
  try {
    const result = await fetchIndexer(data);
    if (result.discovered) $('ixUrl').value = result.discovered;
    if (!$('ixName').value.trim()) $('ixName').value = suggestName(result.title, result.site || data.url);
    const films = result.items.filter((i) => i.type === 'movie').length;
    const series = result.items.filter((i) => i.type === 'tv').length;
    const head = `${KIND_LABEL[result.kind]} · ${plural(result.items.length, 'sortie')} (${plural(films, 'film')}, ${plural(series, 'série')})`;
    const detail = result.discovered
      ? "Flux trouvé sur la page du site : l'adresse a été remplacée par celle du flux."
      : result.items[0] ? `Dernière sortie : ${result.items[0].title}` : 'Le flux est vide pour le moment.';
    showTest('ok', head, detail);
    state.lastTest = { key: formKey(readForm()), result };
    return result;
  } catch (e) {
    showTest('error', 'Lecture impossible', e.message);
    return null;
  } finally {
    $('ixTest').disabled = false;
  }
}

async function saveForm() {
  const data = readForm();
  if (!validUrl(data.url)) {
    showTest('error', 'Adresse invalide', 'Indique une adresse qui commence par http:// ou https://.');
    $('ixUrl').focus();
    return;
  }
  const tested = state.lastTest?.key === formKey(data) ? state.lastTest.result : null;
  data.name ||= suggestName(tested?.title, tested?.site || data.url);

  const list = indexers().slice();
  let ix;
  if (state.editing) {
    const i = list.findIndex((x) => x.id === state.editing);
    const before = list[i];
    ix = { ...before, ...data };
    list[i] = ix;
    // Nouvelle adresse : les anciennes sorties ne correspondent plus.
    if (formKey(before) !== formKey(ix)) {
      delete state.cache[ix.id];
      delete state.seenBefore[ix.id];
      delete state.seenNow[ix.id];
    }
  } else {
    ix = { id: crypto.randomUUID(), ...data };
    list.push(ix);
  }
  state.cfg.indexers = list;
  await setConfig({ indexers: list });
  $('dialog').close();

  if (tested) {
    store(ix, tested);
    saveSoon();
    render();
  } else {
    render();
    if (!state.cache[ix.id]?.at) refresh(ix);
  }
  toast(state.editing ? 'Indexeur modifié' : 'Indexeur ajouté', 'ok');
}

async function deleteIndexer() {
  const ix = findIndexer(state.editing);
  if (!ix || !confirm(`Supprimer l'indexeur « ${ix.name} » ?`)) return;
  state.cfg.indexers = indexers().filter((x) => x.id !== ix.id);
  delete state.cache[ix.id];
  delete state.seenNow[ix.id];
  await setConfig({ indexers: state.cfg.indexers });
  saveSoon();
  $('dialog').close();
  render();
  toast('Indexeur supprimé', 'ok');
}

function applyPreset(name) {
  const p = PRESETS[name];
  $('ixUrl').value = p.url;
  if (p.name && !$('ixName').value.trim()) $('ixName').value = p.name;
  $('urlHint').textContent = p.hint;
  $('testResult').hidden = true;
  const field = $(p.focus || 'ixUrl');
  field.focus();
  if (p.select) {
    const start = p.url.lastIndexOf(p.select);
    field.setSelectionRange(start, start + p.select.length);
  }
}

// --- Démarrage -----------------------------------------------------------------

function bindToolbar() {
  const cfg = state.cfg;
  document.querySelector(`#filter input[value="${cfg.feedFilter}"]`).checked = true;
  document.querySelector(`#view input[value="${cfg.feedView}"]`).checked = true;
  $('count').value = String(cfg.feedCount);

  $('filter').addEventListener('change', (e) => {
    cfg.feedFilter = e.target.value;
    setConfig({ feedFilter: cfg.feedFilter });
    render();
  });
  $('view').addEventListener('change', (e) => {
    cfg.feedView = e.target.value;
    setConfig({ feedView: cfg.feedView });
    render();
  });
  $('count').addEventListener('change', (e) => {
    cfg.feedCount = Number(e.target.value);
    setConfig({ feedCount: cfg.feedCount });
    render();
  });
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value.trim();
    render();
  });
  $('refreshAll').addEventListener('click', () => { refreshAll(); loadQbt(true); });
  $('addBtn').addEventListener('click', () => openDialog());
  $('welcomeAdd').addEventListener('click', () => openDialog());

  const onListClick = (e) => {
    const sendBtn = e.target.closest('.r-send');
    if (sendBtn) { send(sendBtn); return; }
    const act = e.target.closest('[data-act]');
    const card = e.target.closest('.ixcard');
    if (!act || !card) return;
    const ix = findIndexer(card.dataset.id);
    if (!ix) return;
    if (act.dataset.act === 'refresh') refresh(ix);
    else if (act.dataset.act === 'edit') openDialog(ix);
  };
  $('grid').addEventListener('click', onListClick);
  $('tlist').addEventListener('click', onListClick);
}

function bindDialog() {
  const dialog = $('dialog');
  $('dialogClose').addEventListener('click', () => dialog.close());
  // Clic sur le fond assombri : fermeture.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  $('ixForm').addEventListener('submit', (e) => { e.preventDefault(); saveForm(); });
  $('ixTest').addEventListener('click', testForm);
  $('ixDelete').addEventListener('click', deleteIndexer);
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  $('keyToggle').addEventListener('click', () => {
    const show = $('ixKey').type === 'password';
    $('ixKey').type = show ? 'text' : 'password';
    $('keyToggle').innerHTML = icon(show ? 'eyeOff' : 'eye');
    $('keyToggle').title = show ? 'Masquer la clé' : 'Afficher la clé';
  });
  $('ixUrl').addEventListener('input', () => { $('urlHint').textContent = URL_HINT; });
}

async function main() {
  hydrateIcons();
  await initTheme();
  bindThemeButton($('themeBtn'));
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('filesBtn').addEventListener('click', () => { location.href = chrome.runtime.getURL('src/files/files.html'); });

  document.addEventListener('error', onImageError, true);

  state.cfg = await getConfig();
  await loadPosterCache();
  const stored = await chrome.storage.local.get({ [CACHE_KEY]: {}, [SEEN_KEY]: {} });
  state.cache = stored[CACHE_KEY];
  state.seenNow = { ...stored[SEEN_KEY] };
  for (const [id, guids] of Object.entries(stored[SEEN_KEY])) state.seenBefore[id] = new Set(guids);
  // Ce qui est affiché au chargement depuis le cache a déjà été vu.
  for (const [id, c] of Object.entries(state.cache)) {
    if (!state.seenNow[id] && c.items) state.seenNow[id] = c.items.map((i) => i.guid);
  }

  bindToolbar();
  bindDialog();
  render();
  refreshAll(true);
  loadQbt(true);
  setInterval(() => refreshAll(true), AUTO_REFRESH);
  // Les « il y a 5 min » vieillissent.
  setInterval(() => { if (!state.loading.size && !$('dialog').open) render(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(true); });
  window.addEventListener('focus', () => loadQbt());
}

main();
