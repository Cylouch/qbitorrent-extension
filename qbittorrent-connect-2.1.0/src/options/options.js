import { createClient, CLIENTS, clientMeta } from '../lib/clients/index.js';
import { joinPath } from '../lib/clients/base.js';
import { DEFAULTS, getConfig, setConfig, normalizeUrl } from '../lib/config.js';
import { planDestination } from '../lib/organize.js';
import { parseRelease, episodeCode, seasonFolderName, QUALITY_LABELS, LANG_LABELS } from '../lib/media.js';
import { parseFeed, feedError } from '../lib/rss.js';
import { matchItem, matchMovie } from '../lib/alerts.js';
import { searchShows, lookupImdb, akas, schedule } from '../lib/tvmaze.js';
import { SOURCE_LABELS, AUDIO_LABELS, profileOf, rankReleases } from '../lib/quality.js';
import { PRESETS, testIndexer, hasIndexer, findEpisode, findSeason, findMovie } from '../lib/indexer.js';
import { seriesStatus, summarize } from '../lib/wanted.js';
import { findMovieInLibrary } from '../lib/library.js';
import { searchMovies } from '../lib/imdb.js';
import { syncStatus, exportSettings, importableKeys } from '../lib/sync.js';
import { icon } from '../lib/icons.js';
import { $, esc, hydrateIcons, toast } from '../lib/ui.js';
import { initTheme } from '../lib/theme.js';
import { openExplorer } from '../ui/explorer.js';

const SECTIONS = ['client', 'rangement', 'qualite', 'alertes', 'series', 'films', 'sync', 'ajout', 'interception', 'apparence', 'popup', 'apropos'];
const ALIASES = { serveur: 'client' };
const KEEP_ON_RESET = ['client', 'serverUrl', 'username', 'password', 'rpcPath', 'token', 'feeds', 'indexers', 'followed', 'movies',
  'seriesRoot', 'moviesRoot', 'recentPaths'];
const CLIENT_STYLE = {
  qbittorrent: ['qB', '#2f67ba'],
  transmission: ['Tr', '#c8443a'],
  deluge: ['De', '#3a78c4'],
  rtorrent: ['rT', '#4c8c3c'],
  utorrent: ['µT', '#6aa83a'],
  synology: ['DS', '#2c6fd1'],
  flood: ['Fl', '#239b8c'],
  aria2: ['a2', '#7652e0'],
};
const STATUS_FR = { Running: 'En cours', Ended: 'Terminée', 'To Be Determined': 'En attente', 'In Development': 'En développement' };
const SOURCE_HINTS = { web: 'WEBRip, WEB-DL', hdlight: 'HDLight, mHD', bluray: 'BluRay, BDRip, Remux : lourd pour le serveur', hdtv: 'Captures TV', dvd: 'DVDRip' };
const AUDIO_HINTS = { eac3: 'Dolby Digital Plus (DDP)', ac3: 'Dolby Digital (DD)', aac: 'AAC', dts: 'DTS, DTS-HD MA', truehd: 'TrueHD, Atmos', opus: 'Opus', mp3: 'MP3' };
const LANG_OPTIONS = [['any', 'Toute langue'], ['vf', 'VF ou MULTi'], ['multi', 'MULTi'], ['vostfr', 'VOSTFR']];
const TRY_SAMPLE = [
  'Tulsa.King.S04E02.MULTi.1080p.WEB.EAC3.5.1.x265-GRP | 1,4 Go',
  'Tulsa.King.S04E02.MULTi.1080p.WEB-DL.AC3.5.1.H264.COMPACT-GRP | 1,9 Go',
  'Tulsa.King.S04E02.MULTi.1080p.HDLight.AC3.5.1.x264-GRP | 2,1 Go',
  'Tulsa.King.S04E02.MULTi.1080p.BluRay.DTS.5.1.x264-GRP | 6,8 Go',
  'Tulsa.King.S04E02.MULTi.2160p.WEB.EAC3.5.1.x265-GRP | 4,1 Go',
  'Tulsa.King.S04E02.FRENCH.1080p.WEB.AAC.2.0.x264-GRP | 1,1 Go',
].join('\n');
const MOVIE_STATUS = {
  wanted: ['Attendu', 'clock', ''],
  grabbed: ['Envoyé', 'check', 'accent'],
  library: ['Présent', 'hardDrive', 'ok'],
};
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg;
let client = null;
let selectedClient = 'qbittorrent';
let categories = [];

// ---------------------------------------------------------------------------
// Navigation

const opened = new Set();

function showSection(id) {
  id = ALIASES[id] || id;
  if (!SECTIONS.includes(id)) id = 'client';
  for (const s of SECTIONS) $(`s-${s}`).hidden = s !== id;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.hash === `#${id}`));
  window.scrollTo(0, 0);
  if (id === 'sync') renderSync();
  // Première ouverture des séries : analyse de la bibliothèque si elle date.
  if (id === 'series' && !opened.has(id)) scanShows(cfg.followed.map((s) => s.id), { maxAge: 6 * 3600e3 });
  opened.add(id);
}

function setSideStatus(kind, text) {
  $('sideDot').className = `dot ${kind}`;
  $('sideText').textContent = text;
}

const sendMessage = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));

function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

const frDate = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', opts);
const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

// ---------------------------------------------------------------------------
// Réglages génériques (data-setting)

function bindSettings() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = Boolean(cfg[key]);
    else if (el.type === 'radio') el.checked = String(cfg[key]) === el.value;
    else el.value = String(cfg[key] ?? '');

    el.addEventListener('change', async () => {
      if (el.type === 'radio' && !el.checked) return;
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (typeof DEFAULTS[key] === 'number') value = Number(value);
      if (typeof value === 'string') value = value.trim();
      cfg[key] = value;
      await setConfig({ [key]: value });
      toast('Réglage enregistré', 'ok');
      if (['seriesRoot', 'seasonFormat'].includes(key)) updateExample();
      if (key === 'syncEnabled' || key === 'syncSecrets') setTimeout(renderSync, 1500);
    });
  });
}

function fillCategorySelects(names) {
  categories = [...names].sort(collator.compare);
  for (const id of ['defaultCategory', 'seriesCategory', 'moviesCategory']) {
    const sel = $(id);
    const current = cfg[id];
    sel.innerHTML = '';
    sel.append(new Option('Aucune', ''));
    for (const n of categories) sel.append(new Option(n, n));
    if (current && !categories.includes(current)) sel.append(new Option(current, current));
    sel.value = current || '';
  }
}

// ---------------------------------------------------------------------------
// Client torrent

function renderClients() {
  $('clientGrid').innerHTML = CLIENTS.map(({ meta }) => {
    const [mono, color] = CLIENT_STYLE[meta.id] || ['?', '#666'];
    return `<label class="client-card" title="${esc(meta.description)}">
      <input type="radio" name="client" value="${meta.id}" ${meta.id === selectedClient ? 'checked' : ''}>
      <span class="cmono" style="--c:${color}">${esc(mono)}</span>
      <b>${esc(meta.label)}</b>
      ${meta.beta ? '<span class="chip warn beta">bêta</span>' : ''}
    </label>`;
  }).join('');
}

function updateClientForm() {
  const meta = clientMeta(selectedClient);
  $('clientDesc').textContent = meta.description;
  $('serverUrl').placeholder = meta.placeholder;
  $('rpcPath').placeholder = meta.rpcPath || '';
  document.querySelectorAll('[data-field]').forEach((el) => {
    el.hidden = !meta.fields.includes(el.dataset.field);
  });
}

function showResult(kind, title, text, extra = '') {
  const ico = kind === 'info' ? '<span class="spinner"></span>' : icon(kind === 'ok' ? 'checkCircle' : 'alert');
  $('result').className = `card result ${kind}`;
  $('result').innerHTML = `<span class="r-ico">${ico}</span><div class="grow"><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;
  $('result').hidden = false;
}

async function testConnection() {
  if (!cfg.serverUrl) {
    setSideStatus('', 'Non configuré');
    return;
  }
  client = createClient(cfg);
  showResult('info', 'Connexion en cours…', `${client.label} · ${cfg.serverUrl}`);
  setSideStatus('wait', 'Connexion…');
  try {
    const t = await client.test();
    const caps = client.caps;
    const cats = caps.categories ? Object.keys(await client.categories().catch(() => ({}))) : [];
    const feature = (ok, label) => `<span class="chip ${ok ? 'ok' : ''}">${icon(ok ? 'check' : 'x')}${esc(label)}</span>`;
    showResult('ok', 'Connecté', `${t.version}${t.detail ? ` · ${t.detail}` : ''}`, `
      <div class="stats">
        <span class="chip">${icon('globe')}${esc(new URL(cfg.serverUrl).host)}</span>
        ${feature(caps.browse, 'Explorateur de dossiers')}
        ${feature(caps.library, 'Analyse de la bibliothèque')}
        ${feature(caps.categories, caps.categoryPaths ? `${cats.length} catégorie(s)` : 'Étiquettes')}
        ${feature(caps.filePriorities, 'Choix des fichiers')}
      </div>`);
    setSideStatus('ok', t.version);
    fillCategorySelects(cats);
    $('catHint').textContent = cats.length ? "Présélectionnée dans la fenêtre d'ajout" : 'Aucune catégorie sur le client';
  } catch (e) {
    showResult('error', 'Connexion impossible', e.message);
    setSideStatus('err', 'Erreur de connexion');
  }
}

// ---------------------------------------------------------------------------
// Rangement automatique

function quickAccess() {
  return [
    cfg.seriesRoot && { label: 'Séries', path: cfg.seriesRoot, icon: 'tv' },
    cfg.moviesRoot && { label: 'Films', path: cfg.moviesRoot, icon: 'clapperboard' },
    ...cfg.recentPaths.slice(0, 5).map((p) => ({ label: p.split(/[\\/]/).filter(Boolean).pop() || p, path: p, icon: 'history' })),
  ].filter(Boolean);
}

async function browseInto(key) {
  if (!client) {
    toast("Configure d'abord ton client torrent", 'error');
    return;
  }
  const path = await openExplorer({
    client,
    initial: cfg[key] || '',
    quick: quickAccess(),
    title: key === 'seriesRoot' ? 'Dossier des séries' : 'Dossier des films',
  });
  if (!path) return;
  const input = $(key);
  input.value = path;
  input.dispatchEvent(new Event('change'));
}

function updateExample() {
  const root = cfg.seriesRoot || 'B:\\Séries';
  $('exampleTarget').textContent = joinPath(joinPath(root, 'Tulsa King'), seasonFolderName(4, cfg.seasonFormat));
}

async function tryOrganize(name) {
  const box = $('tryResult');
  box.hidden = false;
  box.innerHTML = '<span class="spinner"></span>';
  const info = parseRelease(name);
  let plan = null;
  try {
    plan = client ? await planDestination(client, { ...cfg, autoOrganize: true }, name) : null;
  } catch { /* affichage ci-dessous */ }
  if (!info) {
    box.innerHTML = `<span class="tile">${icon('info')}</span><div><b>Ni série ni film reconnu</b><span class="faint small">Le torrent ira à l'emplacement par défaut.</span></div>`;
    return;
  }
  const what = info.kind === 'movie'
    ? `Film : ${info.title}${info.year ? ` (${info.year})` : ''}`
    : `Série : ${info.title} · ${episodeCode(info)}`;
  const chips = [];
  if (plan && info.kind !== 'movie') {
    chips.push(`<span class="chip ${plan.seriesExists ? 'ok' : 'accent'}">${icon(plan.seriesExists ? 'check' : 'folderPlus')}${plan.seriesExists ? 'Dossier de la série trouvé' : 'Nouveau dossier de série'}</span>`);
    if (plan.seasonName) chips.push(`<span class="chip ${plan.seasonExists ? 'ok' : 'accent'}">${icon(plan.seasonExists ? 'check' : 'folderPlus')}${plan.seasonExists ? 'Saison trouvée' : 'Saison à créer'}</span>`);
    if (!plan.verified) chips.push(`<span class="chip warn">${icon('info')}Dossiers non vérifiés</span>`);
  }
  if (info.quality) chips.push(`<span class="chip">${esc(QUALITY_LABELS[info.quality])}</span>`);
  if (info.lang) chips.push(`<span class="chip">${esc(LANG_LABELS[info.lang])}</span>`);
  const missing = info.kind === 'movie' ? !cfg.moviesRoot : !cfg.seriesRoot;
  box.innerHTML = `<span class="tile">${icon(info.kind === 'movie' ? 'clapperboard' : 'tv')}</span><div class="grow">
    <b>${esc(what)}</b>
    ${plan?.path ? `<div class="path">${esc(plan.path)}</div>` : `<span class="faint small">${missing ? `Indique le dossier des ${info.kind === 'movie' ? 'films' : 'séries'} pour activer le rangement.` : "Connecte ton client pour vérifier les dossiers."}</span>`}
    <div class="chips">${chips.join('')}</div></div>`;
}

// ---------------------------------------------------------------------------
// Profil de qualité

function rankItems(labels, hints, chosen) {
  const order = [...chosen, ...Object.keys(labels).filter((k) => !chosen.includes(k))];
  return order.map((k) => {
    const on = chosen.includes(k);
    const i = chosen.indexOf(k);
    return `<li class="${on ? '' : 'off'}" data-v="${k}">
      <label class="rk-check">
        <input type="checkbox" ${on ? 'checked' : ''}>
        <span class="rk-n">${on ? i + 1 : '–'}</span>
        <span class="grow"><b>${esc(labels[k])}</b><span>${esc(hints[k] || '')}</span></span>
      </label>
      <button type="button" class="btn btn-ghost btn-xs" data-move="-1" title="Monter" ${!on || i === 0 ? 'disabled' : ''}>${icon('arrowUp')}</button>
      <button type="button" class="btn btn-ghost btn-xs" data-move="1" title="Descendre" ${!on || i === chosen.length - 1 ? 'disabled' : ''}>${icon('arrowDown')}</button>
    </li>`;
  }).join('');
}

function renderProfile() {
  const p = profileOf(cfg);
  document.querySelectorAll('input[name=pfResolution]').forEach((r) => { r.checked = r.value === p.resolution; });
  document.querySelectorAll('input[name=pfPriority]').forEach((r) => { r.checked = r.value === p.priority; });
  $('pfSources').innerHTML = rankItems(SOURCE_LABELS, SOURCE_HINTS, p.sources);
  $('pfAudios').innerHTML = rankItems(AUDIO_LABELS, AUDIO_HINTS, p.audios);
  $('pfStereo').checked = p.allowStereo;
  $('pfCompact').checked = p.preferCompact;
  $('pfMargin').value = String(p.compactMargin);
  $('pfMargin').disabled = !p.preferCompact;
}

const readList = (id) => [...$(id).querySelectorAll('li')]
  .filter((li) => li.querySelector('input').checked)
  .map((li) => li.dataset.v);

async function saveProfile() {
  const profile = {
    resolution: document.querySelector('input[name=pfResolution]:checked')?.value || '1080p',
    priority: document.querySelector('input[name=pfPriority]:checked')?.value || 'source',
    sources: readList('pfSources'),
    audios: readList('pfAudios'),
    allowStereo: $('pfStereo').checked,
    preferCompact: $('pfCompact').checked,
    compactMargin: Math.max(0, Number(String($('pfMargin').value).replace(',', '.')) || 0),
  };
  if (!profile.sources.length) {
    toast('Garde au moins une source', 'error');
    renderProfile();
    return;
  }
  cfg.profile = profile;
  await setConfig({ profile });
  renderProfile();
  runTry();
  toast('Profil enregistré', 'ok');
}

function parseSize(text) {
  const m = /([\d.,]+)\s*(to|tb|tib|go|gb|gib|mo|mb|mib)/i.exec(text || '');
  if (!m) return 0;
  const n = Number(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase()[0];
  return Math.round(n * 1024 ** (unit === 't' ? 4 : unit === 'g' ? 3 : 2));
}

function runTry() {
  const items = $('pfTry').value.split('\n').map((line) => {
    const [title, size] = line.split('|');
    return title?.trim() ? { title: title.trim(), size: parseSize(size) } : null;
  }).filter(Boolean);
  const { best, ranked, rejected } = rankReleases(items, profileOf(cfg));
  $('pfRanking').innerHTML = [
    ...ranked.map((r, i) => `<li class="${r === best ? 'best' : ''}">
      <span class="rk-pos">${i + 1}</span>
      <div class="grow"><b class="mono">${esc(r.item.title)}</b><span>${esc(r.label)}</span>${r === best ? `<span class="why">${icon('check')}${esc(r.reason)}</span>` : ''}</div>
      ${r === best ? '<span class="chip ok">Choisie</span>' : ''}
    </li>`),
    ...rejected.map((r) => `<li class="rejected">
      <span class="rk-pos">${icon('x')}</span>
      <div class="grow"><b class="mono">${esc(r.item.title)}</b><span>Refusée : ${esc(r.reason)}</span></div>
    </li>`),
  ].join('') || '<li class="faint small">Colle des noms de releases ci-dessus.</li>';
}

// ---------------------------------------------------------------------------
// Indexeurs et flux RSS

function maskUrl(url) {
  return url.replace(/([?&](passkey|apikey|api_key|key|token|uid|pid|rsskey)=)[^&]+/gi, '$1••••••');
}

const feedStatus = (s) => (s?.error
  ? `<span class="err">Erreur : ${esc(s.error)}</span>`
  : s?.lastCheck ? `<span>Vérifié ${timeAgo(s.lastCheck)} · ${s.count} éléments</span>` : '<span>Pas encore vérifié</span>');

async function renderIndexers() {
  const state = (await chrome.storage.local.get({ feedState: {} })).feedState;
  const list = cfg.indexers || [];
  $('indexers').innerHTML = list.length ? list.map((ix) => `<li class="feed indexer" data-id="${esc(ix.id)}">
      <span class="tile">${icon('search')}</span>
      <div class="feed-text"><b>${esc(ix.name)}</b><span>${esc(ix.url)}</span>${ix.apikey ? feedStatus(state[`ix-${ix.id}`]) : '<span class="err">Clé API manquante</span>'}</div>
      <button type="button" class="btn btn-sm" data-ix-act="key">${icon('key')}${ix.apikey ? 'Clé' : 'Ajouter la clé'}</button>
      <button type="button" class="btn btn-sm" data-ix-act="test" ${ix.apikey ? '' : 'disabled'}>Tester</button>
      <input type="checkbox" class="switch" data-ix-act="toggle" ${ix.enabled !== false ? 'checked' : ''} title="Activer cet indexeur">
      <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-ix-act="delete" title="Supprimer">${icon('trash')}</button>
    </li>`).join('') : '<li class="faint small">Aucun indexeur : sans lui, l\'extension ne peut pas chercher un épisode ou un film précis (seulement repérer les sorties dans les flux RSS).</li>';
}

async function saveIndexers() {
  await setConfig({ indexers: cfg.indexers });
  renderIndexers();
}

async function runIndexerTest(ix) {
  const box = $('indexerTest');
  box.hidden = false;
  box.innerHTML = `<span class="spinner"></span> Test de ${esc(ix.name)}…`;
  try {
    const r = await testIndexer(ix);
    box.innerHTML = `<span class="hit">${icon('checkCircle')} ${esc(r.title)} répond</span> : ${r.count} résultat(s) pour une recherche d'essai. Les recherches d'épisodes et de films passeront par lui.`;
  } catch (e) {
    box.innerHTML = `<span class="err">${icon('alert')} ${esc(e.message)}</span>`;
  }
}

async function renderFeeds() {
  const state = (await chrome.storage.local.get({ feedState: {} })).feedState;
  $('feeds').innerHTML = cfg.feeds.length ? cfg.feeds.map((f) => `<li class="feed" data-id="${esc(f.id)}">
      <span class="tile">${icon('rss')}</span>
      <div class="feed-text"><b>${esc(f.name)}</b><span title="${esc(maskUrl(f.url))}">${esc(maskUrl(f.url))}</span>${feedStatus(state[f.id])}</div>
      <button type="button" class="btn btn-sm" data-feed-act="test">Tester</button>
      <input type="checkbox" class="switch" data-feed-act="toggle" ${f.enabled !== false ? 'checked' : ''} title="Activer ce flux">
      <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-feed-act="delete" title="Supprimer">${icon('trash')}</button>
    </li>`).join('') : '<li class="faint small">Aucun flux pour le moment.</li>';
}

async function saveFeeds() {
  await setConfig({ feeds: cfg.feeds });
  renderFeeds();
}

async function testFeed(url) {
  const box = $('feedTest');
  box.hidden = false;
  box.innerHTML = '<span class="spinner"></span> Lecture du flux…';
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(feedError(res.status, await res.text().catch(() => '')));
    const { title, items } = parseFeed(await res.text());
    if (!items.length) throw new Error("aucun élément trouvé : l'adresse est-elle bien celle d'un flux RSS ?");
    const hit = (i) => {
      const m = matchItem(i, cfg.followed);
      if (m) return `${m.show.name} ${episodeCode(m.info)}`;
      const mm = matchMovie(i, cfg.movies);
      return mm ? mm.movie.title : null;
    };
    const lines = items.slice(0, 8).map((i) => `<li>${hit(i) ? `<span class="hit">✓ ${esc(hit(i))}</span> — ` : ''}${esc(i.title)}</li>`).join('');
    const hits = items.filter(hit).length;
    box.innerHTML = `<b>${esc(title || 'Flux RSS')}</b> : ${items.length} éléments lus${hits ? `, <span class="hit">${hits} correspondent à tes séries et films</span>` : ''}.<ul>${lines}</ul>`;
  } catch (e) {
    box.innerHTML = `<span class="err">${icon('alert')} Lecture impossible : ${esc(e.message)}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Résultats de recherche (épisode, saison, film) et envoi au client

const found = new Map(); // clé → releases classées, pour les boutons « Prendre »

function noIndexerHint() {
  return `<div class="banner warn">${icon('search')}<span class="grow">Ajoute un indexeur (C411, Jackett, Prowlarr…) dans <a href="#alertes">Sources et alertes</a> pour chercher et télécharger ce qui manque.</span></div>`;
}

function renderFound(key, r) {
  found.set(key, r.ranked);
  if (!r.best) {
    const why = r.rejected.length
      ? `${plural(r.rejected.length, 'version trouvée')}, mais refusée${r.rejected.length > 1 ? 's' : ''} par ton profil : ${[...new Set(r.rejected.map((x) => x.reason))].slice(0, 3).join(', ')}.`
      : 'Aucune version disponible pour le moment.';
    return `<div class="pick none">${icon('info')}<span class="grow">${esc(why)}${r.errors.length ? `<br><span class="err">${esc(r.errors.join(' · '))}</span>` : ''}</span></div>`;
  }
  const others = r.ranked.slice(1, 8);
  return `<div class="pick">
      <div class="grow">
        <b>${esc(r.best.label)}</b>
        <span class="mono">${esc(r.best.item.title)}</span>
        <span class="why">${icon('check')}${esc(r.best.reason)}</span>
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-grab="${esc(key)}" data-index="0">${icon('download')}Oui, télécharger</button>
    </div>
    ${others.length ? `<details class="others"><summary>${plural(others.length, 'autre version', 'autres versions')}</summary><ul>
      ${others.map((o, i) => `<li><div class="grow"><b>${esc(o.label)}</b><span class="mono">${esc(o.item.title)}</span></div>
        <button type="button" class="btn btn-sm" data-grab="${esc(key)}" data-index="${i + 1}">Prendre celle-ci</button></li>`).join('')}
    </ul></details>` : ''}`;
}

async function sendGrab(btn, target) {
  const release = found.get(btn.dataset.grab)?.[Number(btn.dataset.index)]?.item;
  if (!release) return false;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Envoi…';
  const r = await sendMessage({ type: 'grab', release, target });
  if (!r?.ok) {
    btn.disabled = false;
    btn.innerHTML = `${icon('download')}Réessayer`;
    toast(r?.error || "Échec de l'envoi", 'error');
    return false;
  }
  toast(`Envoyé à ${client?.label || 'ton client'} : ${release.title}`, 'ok');
  return true;
}

// ---------------------------------------------------------------------------
// Séries suivies

const isFollowed = (id) => cfg.followed.some((s) => s.id === id);
const library = new Map(); // id → état complet (saisons, épisodes), pour la fiche
let libCache = {}; // id → résumé, conservé entre deux ouvertures
const scanning = new Set();

async function follow(show) {
  if (isFollowed(show.id)) return false;
  const [aliases, sched] = await Promise.all([akas(show.id).catch(() => []), schedule(show.id).catch(() => null)]);
  const entry = {
    ...show,
    aliases: aliases.filter((a) => a !== show.name).slice(0, 12),
    quality: 'any',
    lang: 'any',
    autoDownload: false,
    addedAt: Date.now(),
    next: sched?.next || null,
    previous: sched?.previous || null,
    status: sched?.status || show.status,
    scheduleAt: Date.now(),
  };
  // Relit la liste : un import peut tourner en parallèle.
  cfg.followed = [...(await getConfig()).followed.filter((s) => s.id !== show.id), entry];
  await setConfig({ followed: cfg.followed });
  return true;
}

function episodeLabel(e) {
  return `S${String(e.season).padStart(2, '0')}E${String(e.number).padStart(2, '0')}`;
}

// Saisons sous forme de pastilles : S1 ✓, S2 ✓, S4 1/2…
function libraryBlock(s) {
  if (scanning.has(s.id)) return `<div class="lib-line faint"><span class="spinner"></span>Analyse du dossier…</div>`;
  const sum = libCache[s.id];
  if (!sum) return `<div class="lib-line faint">${icon('folderSearch')}Bibliothèque pas encore analysée</div>`;
  if (sum.library === 'no-folder') return `<div class="lib-line warn">${icon('folder')}Aucun dossier « ${esc(s.name)} » dans ${esc(cfg.seriesRoot)}</div>`;
  if (sum.library === 'unavailable') return `<div class="lib-line faint">${icon('info')}${cfg.seriesRoot ? 'Ton client ne permet pas de lister les fichiers' : 'Indique le dossier des séries (Rangement auto)'}</div>`;
  if (sum.library === 'error') return `<div class="lib-line err">${icon('alert')}Lecture du dossier impossible</div>`;
  const aired = sum.seasons.filter((x) => x.total - x.upcoming > 0);
  const chips = aired.map((x) => {
    const out = x.total - x.upcoming;
    const done = x.have + x.grabbed >= out;
    const cls = x.have >= out ? 'ok' : done ? 'accent' : x.have || x.grabbed ? 'warn' : 'err';
    return `<span class="chip ${cls}" title="Saison ${x.season} : ${x.have} présent(s) sur ${out} diffusé(s)${x.upcoming ? `, ${x.upcoming} à venir` : ''}">S${x.season}${x.have >= out ? icon('check') : ` ${x.have}/${out}`}</span>`;
  }).join('');
  const missing = sum.seasons.reduce((n, x) => n + x.missing, 0);
  return `<div class="season-chips">${chips || '<span class="faint small">Aucun épisode diffusé</span>'}</div>
    <div class="lib-line ${missing ? 'err' : 'ok'}">${icon(missing ? 'alert' : 'checkCircle')}${missing ? `${plural(missing, 'épisode manquant', 'épisodes manquants')}` : 'Tout est là'}
      <button type="button" class="btn btn-sm lib-open" data-show-act="open">${missing ? 'Voir et télécharger' : 'Épisodes'}</button></div>`;
}

function showCard(s) {
  const today = new Date().toISOString().slice(0, 10);
  const next = s.next?.airdate && s.next.airdate >= today
    ? `<div class="show-next">${icon('calendar')}${episodeLabel(s.next)} le ${frDate(s.next.airdate)}</div>`
    : `<div class="show-next ended">${icon('calendar')}${s.status === 'Ended' ? 'Série terminée' : 'Pas de date annoncée'}</div>`;
  return `<article class="card show-card" data-id="${s.id}">
      ${s.poster ? `<img class="poster" src="${esc(s.poster)}" alt="" data-show-act="open">` : `<div class="poster noposter" data-show-act="open">${icon('tv')}</div>`}
      <div class="show-body">
        <div class="show-top">
          <h3 data-show-act="open">${esc(s.name)}</h3>
          <button type="button" class="btn btn-ghost btn-xs" data-show-act="remove" title="Ne plus suivre">${icon('x')}</button>
        </div>
        <div class="show-meta">${esc([s.year, s.network, STATUS_FR[s.status] || s.status].filter(Boolean).join(' · '))}</div>
        ${next}
        ${libraryBlock(s)}
        <div class="show-foot">
          <select class="input" data-show-act="lang" title="Langue">
            ${LANG_OPTIONS.map(([v, l]) => `<option value="${v}" ${s.lang === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <label class="show-auto" title="Les nouveaux épisodes sont téléchargés sans rien demander">Auto<input type="checkbox" class="switch" data-show-act="auto" ${s.autoDownload ? 'checked' : ''}></label>
        </div>
      </div>
    </article>`;
}

function renderFollowed() {
  $('seriesCount').textContent = cfg.followed.length || '';
  const list = [...cfg.followed].sort((a, b) => collator.compare(a.name, b.name));
  $('followed').innerHTML = list.length
    ? list.map(showCard).join('')
    : `<div class="followed-empty">${icon('tv')}<b>Aucune série suivie</b><span>Recherche une série ci-dessus ou importe ta liste IMDb.</span></div>`;
}

function refreshCard(id) {
  const old = $('followed').querySelector(`[data-id="${id}"]`);
  const show = cfg.followed.find((s) => s.id === id);
  if (!old || !show) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = showCard(show);
  old.replaceWith(tpl.content.firstElementChild);
}

// Analyse une série après l'autre (TVmaze limite le nombre de requêtes).
async function scanShows(ids, { maxAge = 0 } = {}) {
  const todo = ids.filter((id) => !scanning.has(id) && !(maxAge && libCache[id]?.at > Date.now() - maxAge));
  todo.forEach((id) => scanning.add(id));
  todo.forEach(refreshCard);
  for (const id of todo) {
    const show = cfg.followed.find((s) => s.id === id);
    if (show) {
      try {
        const status = await seriesStatus(client, cfg, show);
        library.set(id, status);
        libCache[id] = summarize(status);
      } catch (e) {
        libCache[id] = { at: Date.now(), library: 'error', folder: '', seasons: [], error: e.message };
      }
    }
    scanning.delete(id);
    refreshCard(id);
    await sleep(250);
  }
}

async function updateShow(id, patch) {
  cfg.followed = cfg.followed.map((s) => (s.id === id ? { ...s, ...patch } : s));
  await setConfig({ followed: cfg.followed });
}

function renderResults(shows) {
  const ul = $('results');
  ul.hidden = false;
  ul.innerHTML = shows.length ? shows.slice(0, 10).map((s) => `
    <li class="result" data-id="${s.id}">
      ${s.poster ? `<img src="${esc(s.poster)}" alt="">` : '<span class="noimg"></span>'}
      <div class="grow"><b>${esc(s.name)}${s.year ? ` (${s.year})` : ''}</b><span>${esc([s.network, STATUS_FR[s.status] || s.status, s.language].filter(Boolean).join(' · '))}</span></div>
      ${isFollowed(s.id)
    ? `<span class="chip ok">${icon('check')}Suivie</span>`
    : `<button type="button" class="btn btn-primary btn-sm" data-follow="${s.id}">${icon('plus')}Suivre</button>`}
    </li>`).join('') : '<li class="faint small">Aucune série trouvée.</li>';
  ul.dataset.shows = JSON.stringify(shows.slice(0, 10));
}

// --- Fiche d'une série : saisons, épisodes présents et manquants ---------------

let modal = null;

function openModal(html) {
  closeModal();
  modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
  document.body.append(modal);
  document.body.classList.add('modal-open');
  return modal.firstElementChild;
}

function closeModal() {
  if (!modal) return;
  modal.remove();
  modal = null;
  document.body.classList.remove('modal-open');
}

const STATE_CHIP = {
  have: () => `<span class="chip ok">${icon('check')}Présent</span>`,
  grabbed: () => `<span class="chip accent">${icon('download')}Envoyé</span>`,
  missing: () => '<span class="chip err">Manquant</span>',
  upcoming: (e) => `<span class="chip">${e.airdate ? frDate(e.airdate) : 'Date inconnue'}</span>`,
};

function seasonBlock(show, s, last, canSearch) {
  const out = s.episodes.length - s.upcoming;
  const pct = out ? Math.round((s.have / out) * 100) : 0;
  const status = s.complete ? `<span class="chip ok">${icon('check')}Complète</span>`
    : [
      out ? `<span class="chip ${s.have >= out ? 'ok' : s.missing ? 'err' : 'accent'}">${s.have}/${out}</span>` : '',
      s.missing ? `<span class="chip err">${plural(s.missing, 'manquant')}</span>` : '',
      s.grabbed ? `<span class="chip accent">${plural(s.grabbed, 'envoyé')}</span>` : '',
      s.upcoming ? `<span class="chip">${s.upcoming} à venir</span>` : '',
    ].join('');
  // Saison entièrement absente et terminée : un pack complet est plus simple.
  const pack = canSearch && s.have === 0 && s.grabbed === 0 && s.missing > 1 && s.upcoming === 0;
  return `<details class="season" data-season="${s.season}" ${!s.complete || last ? 'open' : ''}>
    <summary>
      <span class="season-name">Saison ${s.season}</span>
      <span class="season-bar"><span style="width:${pct}%"></span></span>
      ${status}
    </summary>
    ${pack ? `<div class="pack-row"><span class="grow faint small">Toute la saison manque.</span><button type="button" class="btn btn-sm" data-ep-act="pack">${icon('search')}Chercher la saison complète</button></div><div class="ep-result" data-key="${show.id}:S${s.season}" hidden></div>` : ''}
    <ul class="episodes">
      ${s.episodes.map((e) => `<li class="ep st-${e.state}" data-season="${s.season}" data-episode="${e.number}">
        <span class="ep-n">E${String(e.number).padStart(2, '0')}</span>
        <span class="ep-name">${esc(e.name || '')}</span>
        <span class="ep-date">${e.airdate && e.state !== 'upcoming' ? frDate(e.airdate, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</span>
        ${STATE_CHIP[e.state](e)}
        ${e.state === 'missing' && canSearch ? `<button type="button" class="btn btn-sm" data-ep-act="search">${icon('search')}Chercher</button>` : '<span class="ep-act"></span>'}
        <div class="ep-result" data-key="${show.id}:${s.season}x${e.number}" hidden></div>
      </li>`).join('')}
    </ul>
  </details>`;
}

function renderSeriesModal(box, show, status) {
  const canSearch = hasIndexer(cfg);
  const missing = status.seasons.flatMap((s) => s.episodes.filter((e) => e.state === 'missing').map((e) => ({ season: s.season, number: e.number })));
  const folder = status.folder
    ? `<span class="path">${icon('folder')}${esc(status.folder.path)}</span>`
    : `<span class="warn">${icon('folder')}${status.library === 'unavailable' ? 'Bibliothèque non disponible avec ce client ou sans dossier des séries' : status.library === 'error' ? 'Lecture du dossier impossible' : `Aucun dossier trouvé dans ${esc(cfg.seriesRoot)}`}</span>`;
  box.querySelector('.sm-folder').innerHTML = `${folder}
    ${client?.caps.browse ? `<button type="button" class="btn btn-ghost btn-sm" data-sm-act="folder">${show.folder ? 'Changer' : 'Choisir le dossier'}</button>` : ''}
    ${show.folder ? '<button type="button" class="btn btn-ghost btn-sm" data-sm-act="auto-folder">Détection auto</button>' : ''}`;
  box.querySelector('.sm-body').innerHTML = `
    ${!canSearch && missing.length ? noIndexerHint() : ''}
    ${missing.length && canSearch ? `<div class="missing-bar">
      <span class="tile">${icon('alert')}</span>
      <div class="grow"><b>${plural(missing.length, 'épisode manquant', 'épisodes manquants')}</b><span class="faint small">Diffusés mais absents de ton serveur. Tu veux les télécharger ?</span></div>
      <button type="button" class="btn btn-primary" data-sm-act="search-all">${icon('search')}Tout chercher</button>
    </div>` : ''}
    ${status.seasons.length ? [...status.seasons].reverse().map((s, i) => seasonBlock(show, s, i === 0, canSearch)).join('') : '<p class="faint">Aucun épisode connu sur TVmaze.</p>'}`;
}

async function openSeries(id, { refresh = false } = {}) {
  const show = cfg.followed.find((s) => s.id === id);
  if (!show) return;
  const box = openModal(`
    <header class="sm-head">
      ${show.poster ? `<img class="sm-poster" src="${esc(show.poster)}" alt="">` : `<div class="sm-poster noposter">${icon('tv')}</div>`}
      <div class="grow">
        <h2>${esc(show.name)}</h2>
        <div class="show-meta">${esc([show.year, show.network, STATUS_FR[show.status] || show.status].filter(Boolean).join(' · '))}</div>
        <div class="sm-folder"><span class="spinner"></span></div>
      </div>
      <button type="button" class="btn btn-ghost btn-icon" data-sm-act="rescan" title="Analyser à nouveau">${icon('refresh')}</button>
      <button type="button" class="btn btn-ghost btn-icon" data-sm-act="close" title="Fermer">${icon('x')}</button>
    </header>
    <div class="sm-body"><div class="sm-loading"><span class="spinner"></span>Lecture des épisodes et du dossier…</div></div>`);
  box.dataset.id = id;
  let status = library.get(id);
  if (refresh || !status || Date.now() - status.at > 5 * 60e3) {
    try {
      status = await seriesStatus(client, cfg, show);
    } catch (e) {
      box.querySelector('.sm-body').innerHTML = `<div class="banner error">${icon('alert')}<span>${esc(e.message)}</span></div>`;
      return;
    }
    library.set(id, status);
    libCache[id] = summarize(status);
    refreshCard(id);
  }
  if (box.isConnected) renderSeriesModal(box, show, status);
}

// Après un envoi : l'épisode passe « envoyé » dans la fiche et sur la carte.
function markLocal(showId, season, numbers) {
  const status = library.get(showId);
  if (!status) return;
  for (const s of status.seasons.filter((x) => x.season === season)) {
    s.episodes = s.episodes.map((e) => (numbers.includes(e.number) && e.state === 'missing' ? { ...e, state: 'grabbed' } : e));
    s.missing = s.episodes.filter((e) => e.state === 'missing').length;
    s.grabbed = s.episodes.filter((e) => e.state === 'grabbed').length;
  }
  libCache[showId] = summarize(status);
  refreshCard(showId);
}

async function searchEpisode(box, li) {
  const show = cfg.followed.find((s) => s.id === Number(box.dataset.id));
  const season = Number(li.dataset.season);
  const episode = Number(li.dataset.episode);
  const res = li.querySelector('.ep-result');
  const btn = li.querySelector('[data-ep-act=search]');
  if (btn) btn.disabled = true;
  res.hidden = false;
  res.innerHTML = '<span class="spinner"></span> Recherche sur tes indexeurs…';
  try {
    const r = await findEpisode(cfg, show, season, episode);
    res.innerHTML = renderFound(res.dataset.key, r);
    return r.best ? res.dataset.key : null;
  } catch (e) {
    res.innerHTML = `<span class="err">${icon('alert')} ${esc(e.message)}</span>`;
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onModalClick(e) {
  const box = e.target.closest('.modal');
  if (!box) return;
  const id = Number(box.dataset.id);
  const show = cfg.followed.find((s) => s.id === id);
  const act = e.target.closest('[data-sm-act]')?.dataset.smAct;
  if (act === 'close') return closeModal();
  if (act === 'rescan') return openSeries(id, { refresh: true });
  if (act === 'folder') {
    const path = await openExplorer({ client, initial: show.folder || libCache[id]?.folder || cfg.seriesRoot, quick: quickAccess(), title: `Dossier de ${show.name}` });
    if (!path) return;
    await updateShow(id, { folder: path });
    return openSeries(id, { refresh: true });
  }
  if (act === 'auto-folder') {
    await updateShow(id, { folder: '' });
    return openSeries(id, { refresh: true });
  }
  if (act === 'search-all') {
    const btn = e.target.closest('button');
    btn.disabled = true;
    const hits = [];
    const items = [...box.querySelectorAll('.ep.st-missing')];
    for (const [i, li] of items.entries()) {
      btn.innerHTML = `<span class="spinner"></span>Recherche ${i + 1} / ${items.length}…`;
      li.closest('details').open = true;
      const key = await searchEpisode(box, li);
      if (key) hits.push(li);
      await sleep(800);
    }
    btn.disabled = !hits.length;
    btn.innerHTML = hits.length ? `${icon('download')}Tout télécharger (${hits.length})` : 'Rien trouvé';
    btn.dataset.smAct = 'grab-all';
    return;
  }
  if (act === 'grab-all') {
    const btn = e.target.closest('button');
    btn.disabled = true;
    for (const li of box.querySelectorAll('.ep.st-missing')) {
      const grabBtn = li.querySelector('[data-grab][data-index="0"]');
      if (grabBtn && await sendGrab(grabBtn, { showId: id, season: Number(li.dataset.season), episode: Number(li.dataset.episode) })) {
        markLocal(id, Number(li.dataset.season), [Number(li.dataset.episode)]);
      }
    }
    return renderSeriesModal(box, show, library.get(id));
  }

  const li = e.target.closest('.ep');
  const epAct = e.target.closest('[data-ep-act]')?.dataset.epAct;
  if (epAct === 'search' && li) return searchEpisode(box, li);
  if (epAct === 'pack') {
    const details = e.target.closest('details');
    const season = Number(details.dataset.season);
    const res = details.querySelector('.pack-row + .ep-result');
    res.hidden = false;
    res.innerHTML = '<span class="spinner"></span> Recherche du pack de la saison…';
    try {
      const count = library.get(id)?.seasons.find((s) => s.season === season)?.episodes.length || 1;
      res.innerHTML = renderFound(res.dataset.key, await findSeason(cfg, show, season, count));
    } catch (err) {
      res.innerHTML = `<span class="err">${icon('alert')} ${esc(err.message)}</span>`;
    }
    return;
  }

  const grabBtn = e.target.closest('[data-grab]');
  if (grabBtn) {
    const pack = /:S(\d+)$/.exec(grabBtn.dataset.grab);
    if (pack) {
      const season = Number(pack[1]);
      const numbers = library.get(id).seasons.find((s) => s.season === season).episodes.filter((x) => x.state === 'missing').map((x) => x.number);
      if (await sendGrab(grabBtn, { showId: id, season, episodes: numbers })) markLocal(id, season, numbers);
    } else if (li && await sendGrab(grabBtn, { showId: id, season: Number(li.dataset.season), episode: Number(li.dataset.episode) })) {
      markLocal(id, Number(li.dataset.season), [Number(li.dataset.episode)]);
    } else return;
    renderSeriesModal(box, show, library.get(id));
  }
}

// ---------------------------------------------------------------------------
// Films suivis

const isMovieFollowed = (id) => cfg.movies.some((m) => m.id === id);

async function followMovie(movie) {
  if (isMovieFollowed(movie.id)) return false;
  const entry = { ...movie, addedAt: Date.now(), status: 'wanted', autoDownload: true, lang: 'any' };
  cfg.movies = [...(await getConfig()).movies.filter((m) => m.id !== movie.id), entry];
  await setConfig({ movies: cfg.movies });
  return true;
}

async function updateMovie(id, patch) {
  cfg.movies = cfg.movies.map((m) => (m.id === id ? { ...m, ...patch } : m));
  await setConfig({ movies: cfg.movies });
}

function movieCard(m) {
  const st = MOVIE_STATUS[m.status] ? m.status : 'wanted';
  const [label, ico, cls] = MOVIE_STATUS[st];
  const sub = st === 'grabbed' ? `Envoyé ${timeAgo(m.grabbedAt || Date.now())}${m.grabbedTitle ? ` : ${m.grabbedTitle}` : ''}`
    : st === 'library' ? 'Déjà dans ton dossier des films'
      : m.lastSearch ? (m.lastResult ? `Trouvé : ${m.lastResult}` : `Pas encore disponible dans ton profil · cherché ${timeAgo(m.lastSearch)}`)
        : 'Pas encore cherché';
  return `<article class="card movie-card" data-id="${esc(m.id)}">
      <div class="mc-poster">
        ${m.poster ? `<img src="${esc(m.poster)}" alt="" referrerpolicy="no-referrer">` : icon('clapperboard')}
        <span class="chip ${cls} mc-status">${icon(ico)}${label}</span>
      </div>
      <div class="mc-body">
        <div class="show-top">
          <h3>${esc(m.title)}</h3>
          <button type="button" class="btn btn-ghost btn-xs" data-movie-act="remove" title="Ne plus suivre">${icon('x')}</button>
        </div>
        <div class="show-meta">${esc([m.year, m.cast].filter(Boolean).join(' · '))}</div>
        <div class="mc-sub" title="${esc(sub)}">${esc(sub)}</div>
        <div class="show-foot">
          <select class="input" data-movie-act="lang" title="Langue">
            ${LANG_OPTIONS.map(([v, l]) => `<option value="${v}" ${m.lang === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <label class="show-auto" title="Téléchargé dès sa sortie, sans rien demander">Auto<input type="checkbox" class="switch" data-movie-act="auto" ${m.autoDownload !== false ? 'checked' : ''}></label>
        </div>
        <div class="row mc-actions">
          ${st === 'wanted'
    ? `<button type="button" class="btn btn-sm" data-movie-act="search">${icon('search')}Chercher maintenant</button>`
    : `<button type="button" class="btn btn-sm" data-movie-act="reset">${icon('rotateCcw')}Remettre en attente</button>`}
          ${m.url ? `<a class="small" href="${esc(m.url)}" target="_blank" rel="noopener">IMDb</a>` : ''}
        </div>
      </div>
      <div class="ep-result" data-key="movie:${esc(m.id)}" hidden></div>
    </article>`;
}

function renderMovies() {
  $('moviesCount').textContent = cfg.movies.length || '';
  const filter = document.querySelector('input[name=movieFilter]:checked')?.value || 'all';
  const list = cfg.movies
    .filter((m) => filter === 'all' || (MOVIE_STATUS[m.status] ? m.status : 'wanted') === filter)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  $('movies').innerHTML = list.length
    ? list.map(movieCard).join('')
    : `<div class="followed-empty">${icon('clapperboard')}<b>${cfg.movies.length ? 'Aucun film ici' : 'Aucun film suivi'}</b><span>${cfg.movies.length ? 'Change de filtre pour voir les autres.' : 'Recherche un film ci-dessus : il sera téléchargé dès sa sortie.'}</span></div>`;
}

function renderMovieResults(movies) {
  const ul = $('movieResults');
  ul.hidden = false;
  ul.innerHTML = movies.length ? movies.slice(0, 10).map((m) => `
    <li class="result" data-id="${esc(m.id)}">
      ${m.poster ? `<img src="${esc(m.poster)}" alt="" referrerpolicy="no-referrer">` : '<span class="noimg"></span>'}
      <div class="grow"><b>${esc(m.title)}${m.year ? ` (${m.year})` : ''}</b><span>${esc(m.cast)}</span></div>
      ${isMovieFollowed(m.id)
    ? `<span class="chip ok">${icon('check')}Suivi</span>`
    : `<button type="button" class="btn btn-primary btn-sm" data-follow-movie="${esc(m.id)}">${icon('plus')}Suivre</button>`}
    </li>`).join('') : '<li class="faint small">Aucun film trouvé.</li>';
  ul.dataset.movies = JSON.stringify(movies.slice(0, 10));
}

async function searchMovieNow(card) {
  const movie = cfg.movies.find((m) => m.id === card.dataset.id);
  const res = card.querySelector('.ep-result');
  res.hidden = false;
  if (!hasIndexer(cfg)) {
    res.innerHTML = noIndexerHint();
    return;
  }
  res.innerHTML = '<span class="spinner"></span> Recherche…';
  try {
    const inLib = client ? await findMovieInLibrary(client, cfg, movie).catch(() => null) : null;
    if (inLib) {
      await updateMovie(movie.id, { status: 'library' });
      renderMovies();
      toast(`Déjà sur le serveur : ${inLib.name}`, 'ok');
      return;
    }
    const r = await findMovie(cfg, movie);
    await updateMovie(movie.id, { lastSearch: Date.now(), lastResult: r.best ? r.best.label : '' });
    // La carte a pu être redessinée entre-temps.
    const box = $('movies').querySelector(`[data-id="${CSS.escape(movie.id)}"] .ep-result`) || res;
    box.hidden = false;
    box.innerHTML = renderFound(box.dataset.key, r);
  } catch (e) {
    res.innerHTML = `<span class="err">${icon('alert')} ${esc(e.message)}</span>`;
  }
}

// --- Import IMDb (CSV) : séries et films ---------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

async function importImdb(file) {
  const status = $('imdbStatus');
  const rows = parseCsv(await file.text());
  const head = rows.shift()?.map((h) => h.trim().toLowerCase()) || [];
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iConst = col('const', 'tconst');
  const iType = col('title type', 'titletype');
  const iTitle = col('title', 'primarytitle');
  const iYear = col('year', 'startyear');
  if (iConst < 0) {
    status.textContent = "Ce fichier ne ressemble pas à un export IMDb (colonne « Const » absente).";
    return;
  }
  const isSeries = (r) => /series|mini/i.test(r[iType] || '');
  const isMovie = (r) => iType >= 0 && /^(movie|tv ?movie|tvmovie|film)$/i.test((r[iType] || '').trim());
  const series = rows.filter((r) => iType < 0 || isSeries(r));
  const movies = rows.filter(isMovie);
  if (!series.length && !movies.length) {
    status.textContent = 'Aucune série ni aucun film dans ce fichier.';
    return;
  }
  let added = 0;
  let missed = 0;
  let addedMovies = 0;
  for (let i = 0; i < series.length; i++) {
    status.textContent = `Import des séries… ${i + 1} / ${series.length}`;
    try {
      const show = await lookupImdb(series[i][iConst].trim());
      if (show && await follow(show)) added++;
      else if (!show) missed++;
    } catch {
      missed++;
    }
    renderFollowed();
    await sleep(500);
  }
  for (let i = 0; i < movies.length; i++) {
    status.textContent = `Import des films… ${i + 1} / ${movies.length}`;
    const id = movies[i][iConst].trim();
    if (isMovieFollowed(id)) continue;
    // Affiche et distribution via la recherche IMDb ; à défaut, les colonnes du fichier.
    const hit = (await searchMovies(id).catch(() => [])).find((m) => m.id === id);
    const movie = hit || { id, title: movies[i][iTitle] || id, year: Number(movies[i][iYear]) || null, poster: '', cast: '', url: `https://www.imdb.com/title/${id}/` };
    if (await followMovie(movie)) addedMovies++;
    renderMovies();
    await sleep(300);
  }
  status.textContent = [
    series.length && `${plural(added, 'série ajoutée', 'séries ajoutées')}${missed ? ` (${missed} introuvable(s) sur TVmaze)` : ''}`,
    movies.length && plural(addedMovies, 'film ajouté', 'films ajoutés'),
  ].filter(Boolean).join(', ') + '.';
}

// ---------------------------------------------------------------------------
// Synchronisation

async function renderSync() {
  const st = await syncStatus();
  const pct = Math.min(100, Math.round((st.bytes / st.quota) * 100));
  $('syncBar').style.width = `${Math.max(pct, st.bytes ? 2 : 0)}%`;
  $('syncBar').classList.toggle('full', pct > 85);
  $('syncBytes').textContent = `${(st.bytes / 1024).toFixed(1).replace('.', ',')} Ko utilisés sur ${Math.round(st.quota / 1024)} Ko`;
  $('syncText').innerHTML = st.error
    ? `<span class="err">${icon('alert')}${esc(st.error)}</span>`
    : cfg.syncEnabled
      ? `<span class="ok">${icon('checkCircle')}Active : ${plural(cfg.followed.length, 'série')}, ${plural(cfg.movies.length, 'film')} et tes réglages suivent ton compte Google</span>`
      : `<span class="faint">${icon('info')}Désactivée : tout reste sur ce PC</span>`;
  $('syncNow').disabled = !cfg.syncEnabled;
}

async function exportFile() {
  const data = await exportSettings({ secrets: $('exportSecrets').checked });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `torrent-connect-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importFile(file) {
  const status = $('importStatus');
  try {
    const patch = importableKeys(JSON.parse(await file.text()), cfg);
    const what = [plural(patch.followed?.length || 0, 'série'), plural(patch.movies?.length || 0, 'film')].join(', ');
    if (!confirm(`Importer cette sauvegarde (${what}, ${Object.keys(patch).length} réglages) ?\nLes réglages de ce navigateur seront remplacés.`)) return;
    await setConfig(patch);
    toast('Sauvegarde importée', 'ok');
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    status.textContent = e instanceof SyntaxError ? "Ce fichier n'est pas un JSON valide." : e.message;
  }
}

// ---------------------------------------------------------------------------

function updateRecent() {
  const n = cfg.recentPaths.length;
  $('recentHint').textContent = n ? `${n} emplacement${n > 1 ? 's' : ''} mémorisé${n > 1 ? 's' : ''}` : 'Aucun emplacement mémorisé';
  $('clearRecent').disabled = !n;
}

async function showFileAccess() {
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  $('fileAccessChip').className = `chip ${allowed ? 'ok' : 'warn'}`;
  $('fileAccessChip').innerHTML = `${icon(allowed ? 'check' : 'alert')}${allowed ? 'Activé' : 'Désactivé'}`;
  $('fileAccessText').textContent = allowed
    ? "L'extension lit directement le .torrent téléchargé : ça marche même avec les liens à usage unique des trackers privés."
    : "L'extension retélécharge le .torrent depuis le site, avec tes cookies. Pour plus de fiabilité, active « Autoriser l'accès aux URL de fichier » sur la page de l'extension.";
}

async function checkNow() {
  $('checkNow').disabled = true;
  $('checkResult').textContent = 'Lecture des flux…';
  const parts = [];
  const r = await sendMessage({ type: 'check-feeds' });
  if (!r?.ok) parts.push(r?.error || 'Vérification impossible');
  else if (r.value.checked) {
    parts.push(plural(r.value.fresh, 'nouvelle sortie', 'nouvelles sorties'));
    parts.push(...r.value.errors.map((x) => `${x.feed} : ${x.error}`));
  }
  if (hasIndexer(cfg) && cfg.serverUrl && (cfg.followed.length || cfg.movies.length)) {
    $('checkResult').textContent = 'Recherche de ce qui manque…';
    const w = await sendMessage({ type: 'run-wanted' });
    if (w?.ok) {
      parts.push(`${plural(w.value.found, 'épisode ou film trouvé', 'épisodes ou films trouvés')}`);
      parts.push(...[...new Set(w.value.errors)].slice(0, 2));
    } else parts.push(w?.error || 'Recherche impossible');
  }
  $('checkResult').textContent = parts.length ? parts.join(' · ') : 'Aucun flux ni indexeur actif.';
  $('checkNow').disabled = false;
  renderFeeds();
  renderIndexers();
}

async function main() {
  hydrateIcons();
  await initTheme();
  cfg = await getConfig();
  libCache = (await chrome.storage.local.get({ libraryCache: {} })).libraryCache;
  selectedClient = cfg.client;
  const version = chrome.runtime.getManifest().version;
  $('version').textContent = `Version ${version}`;
  $('aboutVersion').textContent = `Version ${version}`;

  // Client torrent
  renderClients();
  updateClientForm();
  $('clientGrid').addEventListener('change', (e) => {
    selectedClient = e.target.value;
    updateClientForm();
  });
  $('serverUrl').value = cfg.serverUrl;
  $('username').value = cfg.username;
  $('password').value = cfg.password;
  $('rpcPath').value = cfg.rpcPath;
  $('token').value = cfg.token;
  $('pwToggle').addEventListener('click', () => {
    const show = $('password').type === 'password';
    $('password').type = show ? 'text' : 'password';
    $('pwToggle').innerHTML = icon(show ? 'eyeOff' : 'eye');
  });
  $('serverForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {
      client: selectedClient,
      serverUrl: normalizeUrl($('serverUrl').value),
      username: $('username').value.trim(),
      password: $('password').value,
      rpcPath: $('rpcPath').value.trim(),
      token: $('token').value,
    };
    $('serverUrl').value = patch.serverUrl;
    $('saveBtn').disabled = true;
    Object.assign(cfg, patch);
    await setConfig(patch);
    await testConnection();
    $('saveBtn').disabled = false;
  });
  $('openWebui').addEventListener('click', () => {
    if (cfg.serverUrl) chrome.tabs.create({ url: createClient(cfg).webUrl });
    else toast("Indique d'abord l'adresse du client", 'error');
  });
  if (cfg.serverUrl) client = createClient(cfg);

  // Réglages génériques
  fillCategorySelects([]);
  bindSettings();
  updateExample();
  updateRecent();
  $('clearRecent').addEventListener('click', async () => {
    cfg.recentPaths = [];
    await setConfig({ recentPaths: [] });
    updateRecent();
    toast('Emplacements récents effacés', 'ok');
  });

  // Rangement
  document.querySelectorAll('[data-browse]').forEach((b) => b.addEventListener('click', () => browseInto(b.dataset.browse)));
  $('tryForm').addEventListener('submit', (e) => {
    e.preventDefault();
    tryOrganize($('tryInput').value.trim());
  });

  // Profil de qualité
  renderProfile();
  $('pfTry').value = TRY_SAMPLE;
  runTry();
  $('s-qualite').addEventListener('change', (e) => {
    if (e.target.id === 'pfTry') return;
    saveProfile();
  });
  $('s-qualite').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const li = btn.closest('li');
    const sibling = Number(btn.dataset.move) < 0 ? li.previousElementSibling : li.nextElementSibling;
    if (!sibling) return;
    if (Number(btn.dataset.move) < 0) sibling.before(li);
    else sibling.after(li);
    saveProfile();
  });
  $('pfTryBtn').addEventListener('click', runTry);

  // Indexeurs
  renderIndexers();
  $('ixC411').addEventListener('click', () => {
    $('ixName').value = PRESETS.c411.name;
    $('ixUrl').value = PRESETS.c411.url;
    $('ixKey').focus();
  });
  $('indexerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('ixUrl').value.trim().replace(/[?&]+$/, '');
    const apikey = $('ixKey').value.trim();
    if (!/^https?:\/\//i.test(url) || !apikey) return;
    let name = $('ixName').value.trim();
    if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = 'Indexeur'; } }
    const ix = { id: crypto.randomUUID(), name, url, apikey, enabled: true };
    cfg.indexers = [...(cfg.indexers || []), ix];
    ['ixName', 'ixUrl', 'ixKey'].forEach((id) => { $(id).value = ''; });
    await saveIndexers();
    toast('Indexeur ajouté', 'ok');
    runIndexerTest(ix);
  });
  $('indexers').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-ix-act]')?.dataset.ixAct;
    const id = e.target.closest('[data-id]')?.dataset.id;
    const ix = cfg.indexers.find((x) => x.id === id);
    if (!ix || !act || act === 'toggle') return;
    if (act === 'test') runIndexerTest(ix);
    if (act === 'key') {
      const key = prompt(`Clé API pour ${ix.name} :`)?.trim();
      if (!key) return;
      cfg.indexers = cfg.indexers.map((x) => (x.id === id ? { ...x, apikey: key } : x));
      await saveIndexers();
      runIndexerTest({ ...ix, apikey: key });
    }
    if (act === 'delete' && confirm(`Supprimer l'indexeur « ${ix.name} » ?`)) {
      cfg.indexers = cfg.indexers.filter((x) => x.id !== id);
      await saveIndexers();
    }
  });
  $('indexers').addEventListener('change', async (e) => {
    if (e.target.dataset.ixAct !== 'toggle') return;
    const id = e.target.closest('[data-id]').dataset.id;
    cfg.indexers = cfg.indexers.map((x) => (x.id === id ? { ...x, enabled: e.target.checked } : x));
    await saveIndexers();
  });

  // Flux RSS
  renderFeeds();
  $('feedForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('feedUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) return;
    let name = $('feedName').value.trim();
    if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = 'Flux RSS'; } }
    cfg.feeds = [...cfg.feeds, { id: crypto.randomUUID(), name, url, enabled: true }];
    $('feedName').value = '';
    $('feedUrl').value = '';
    await saveFeeds();
    toast('Flux ajouté', 'ok');
    testFeed(url);
  });
  $('feeds').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-feed-act]')?.dataset.feedAct;
    const id = e.target.closest('[data-id]')?.dataset.id;
    const feed = cfg.feeds.find((f) => f.id === id);
    if (!feed || !act) return;
    if (act === 'test') testFeed(feed.url);
    if (act === 'delete' && confirm(`Supprimer le flux « ${feed.name} » ?`)) {
      cfg.feeds = cfg.feeds.filter((f) => f.id !== id);
      await saveFeeds();
    }
  });
  $('feeds').addEventListener('change', async (e) => {
    if (e.target.dataset.feedAct !== 'toggle') return;
    const id = e.target.closest('[data-id]').dataset.id;
    cfg.feeds = cfg.feeds.map((f) => (f.id === id ? { ...f, enabled: e.target.checked } : f));
    await saveFeeds();
  });
  $('checkNow').addEventListener('click', checkNow);

  // Séries suivies
  renderFollowed();
  $('scanAll').addEventListener('click', () => scanShows(cfg.followed.map((s) => s.id)));
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('showSearch').value.trim();
    if (!q) return;
    $('results').hidden = false;
    $('results').innerHTML = '<li><span class="spinner"></span></li>';
    try {
      renderResults(await searchShows(q));
    } catch (err) {
      $('results').innerHTML = `<li class="faint small">${esc(err.message)}</li>`;
    }
  });
  $('results').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-follow]');
    if (!btn) return;
    const shows = JSON.parse($('results').dataset.shows || '[]');
    const show = shows.find((s) => String(s.id) === btn.dataset.follow);
    if (!show) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    await follow(show);
    renderFollowed();
    renderResults(shows);
    toast(`${show.name} ajoutée aux séries suivies`, 'ok');
    scanShows([show.id]);
  });
  $('followed').addEventListener('change', (e) => {
    const card = e.target.closest('[data-id]');
    const act = e.target.dataset.showAct;
    if (!card || !act) return;
    const id = Number(card.dataset.id);
    if (act === 'lang') updateShow(id, { lang: e.target.value });
    if (act === 'auto') updateShow(id, { autoDownload: e.target.checked });
  });
  $('followed').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-show-act]')?.dataset.showAct;
    const card = e.target.closest('[data-id]');
    if (!card || !act) return;
    const id = Number(card.dataset.id);
    if (act === 'open') openSeries(id);
    if (act === 'remove') {
      const show = cfg.followed.find((s) => s.id === id);
      if (!show || !confirm(`Ne plus suivre « ${show.name} » ?`)) return;
      cfg.followed = cfg.followed.filter((s) => s.id !== id);
      await setConfig({ followed: cfg.followed });
      renderFollowed();
    }
  });
  $('imdbFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importImdb(e.target.files[0]);
    e.target.value = '';
  });
  document.addEventListener('click', (e) => { if (modal?.contains(e.target)) onModalClick(e); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !document.querySelector('.xp-backdrop')) closeModal(); });

  // Films suivis
  renderMovies();
  $('movieForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('movieSearch').value.trim();
    if (!q) return;
    $('movieResults').hidden = false;
    $('movieResults').innerHTML = '<li><span class="spinner"></span></li>';
    try {
      renderMovieResults(await searchMovies(q));
    } catch (err) {
      $('movieResults').innerHTML = `<li class="faint small">${esc(err.message)}</li>`;
    }
  });
  $('movieResults').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-follow-movie]');
    if (!btn) return;
    const movies = JSON.parse($('movieResults').dataset.movies || '[]');
    const movie = movies.find((m) => m.id === btn.dataset.followMovie);
    if (!movie) return;
    await followMovie(movie);
    renderMovies();
    renderMovieResults(movies);
    toast(`${movie.title} ajouté aux films suivis`, 'ok');
  });
  $('movieFilter').addEventListener('change', renderMovies);
  $('movies').addEventListener('change', (e) => {
    const card = e.target.closest('[data-id]');
    const act = e.target.dataset.movieAct;
    if (!card || !act) return;
    if (act === 'lang') updateMovie(card.dataset.id, { lang: e.target.value });
    if (act === 'auto') updateMovie(card.dataset.id, { autoDownload: e.target.checked });
  });
  $('movies').addEventListener('click', async (e) => {
    const card = e.target.closest('.movie-card');
    if (!card) return;
    const grabBtn = e.target.closest('[data-grab]');
    if (grabBtn) {
      if (await sendGrab(grabBtn, { movieId: card.dataset.id })) renderMovies();
      return;
    }
    const act = e.target.closest('[data-movie-act]')?.dataset.movieAct;
    const movie = cfg.movies.find((m) => m.id === card.dataset.id);
    if (!movie) return;
    if (act === 'search') searchMovieNow(card);
    if (act === 'reset') {
      await updateMovie(movie.id, { status: 'wanted', grabbedAt: null, grabbedTitle: '' });
      renderMovies();
    }
    if (act === 'remove' && confirm(`Ne plus suivre « ${movie.title} » ?`)) {
      cfg.movies = cfg.movies.filter((m) => m.id !== movie.id);
      await setConfig({ movies: cfg.movies });
      renderMovies();
    }
  });

  // Synchronisation
  $('syncNow').addEventListener('click', async () => {
    $('syncNow').disabled = true;
    const r = await sendMessage({ type: 'sync-now' });
    if (r?.ok) toast(`Synchronisé : ${r.value.received.length} reçu(s), ${r.value.pushed.length} envoyé(s)`, 'ok');
    else toast(r?.error || 'Synchronisation impossible', 'error');
    renderSync();
  });
  $('exportBtn').addEventListener('click', exportFile);
  $('importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = '';
  });

  // Mises à jour faites par le service d'arrière-plan ou reçues d'un autre PC.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS && newValue !== undefined) cfg[key] = newValue;
    }
    const editing = (id) => document.activeElement?.closest?.(`#${id}`);
    if (changes.followed && !editing('followed')) renderFollowed();
    if (changes.movies && !editing('movies')) renderMovies();
    if (changes.libraryCache) {
      libCache = { ...libCache, ...changes.libraryCache.newValue };
      if (!editing('followed')) renderFollowed();
    }
    if (changes.profile && !editing('s-qualite')) { renderProfile(); runTry(); }
    if (changes.feedState) { renderFeeds(); renderIndexers(); }
    if (changes.feeds) renderFeeds();
    if (changes.indexers) renderIndexers();
    if (changes.syncError || changes.syncState) renderSync();
  });

  // Interception, à propos
  $('openExt').addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
  showFileAccess();
  window.addEventListener('focus', showFileAccess);
  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Réinitialiser les réglages ? Le client, les flux, les indexeurs, les séries et les films suivis sont conservés.')) return;
    const patch = Object.fromEntries(Object.entries(DEFAULTS).filter(([k]) => !KEEP_ON_RESET.includes(k)));
    await setConfig(patch);
    location.reload();
  });

  showSection(location.hash.slice(1));
  window.addEventListener('hashchange', () => { closeModal(); showSection(location.hash.slice(1)); });

  testConnection();
}

main();
