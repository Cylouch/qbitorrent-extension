// Affiches des sorties : celle donnée par le flux en priorité, sinon une recherche
// sur IMDb via le service de suggestions de sa barre de recherche (sans clé,
// non officiel), à partir du titre lu dans le nom de la release. Les réponses
// sont gardées : chaque film ou série n'est cherché qu'une fois.

const CACHE_KEY = 'posterCache';
const MISS_TTL = 3 * 24 * 3600 * 1000;
const MAX_ENTRIES = 1500;
const CONCURRENCY = 3;
const TIMEOUT = 10000;

// --- Noms de releases -----------------------------------------------------------

const MOVIE_HINT = /\b(2160p|1080[pi]|720p|576p|480p|4k|uhd|blu-?ray|bdrip|brrip|remux|web[- ]?dl|webrip|web|hdrip|dvdrip|hdtv|hdlight|mhd|x26[45]|h ?26[45]|hevc|av1|multi|french|truefrench|vostfr|vff|vfq|subfrench)\b/i;

// Retire les préfixes de site, tags entre crochets, extensions, séparateurs.
function flatten(name) {
  return name
    .replace(/\.(torrent|mkv|mp4|avi|m4v|ts)$/i, '')
    .replace(/^\s*(\[[^\]]*\]\s*)+/, '')
    .replace(/^\s*(www\.)?[a-z0-9-]+\.(com|org|net|to|cc|tv|fr|me|io|ws)\s*[-–_]\s*/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(raw) {
  let title = raw.replace(/[\s\-–:([{]+$/, '').replace(/^[\s\-–]+/, '').trim();
  let year = null;
  const y = /\s\(?((?:19|20)\d{2})\)?$/.exec(title);
  if (y) {
    year = Number(y[1]);
    title = title.slice(0, y.index).trim();
  }
  return { title, year };
}

const pad = (n) => String(Number(n)).padStart(2, '0');

// { kind: 'movie' | 'tv', title, year, code } ; code : « S04E01 », « Saison 2 »…
export function parseRelease(name) {
  if (!name) return null;
  const flat = flatten(name);
  let m;
  const show = (index, code) => {
    const { title, year } = cleanTitle(flat.slice(0, index));
    return title ? { kind: 'tv', title, year, code } : null;
  };

  if ((m = /\bS(\d{1,2}) ?- ?S?(\d{1,2})\b/i.exec(flat))) return show(m.index, `Saisons ${+m[1]} à ${+m[2]}`);
  if ((m = /\bS(\d{1,3}) ?E(\d{1,4})/i.exec(flat))) return show(m.index, `S${pad(m[1])}E${pad(m[2])}`);
  if ((m = /\b(\d{1,2})x(\d{2,3})\b/.exec(flat))) return show(m.index, `S${pad(m[1])}E${pad(m[2])}`);
  if ((m = /\b(?:saison|season) ?(\d{1,2})\b/i.exec(flat))) return show(m.index, `Saison ${+m[1]}`);
  if ((m = /\bS(\d{1,2})\b/i.exec(flat))) return show(m.index, `Saison ${+m[1]}`);
  if ((m = /\bE(\d{2,4})\b/.exec(flat))) return show(m.index, `Épisode ${+m[1]}`);
  if ((m = /\b(int[ée]grale|the complete series|complete series)\b/i.exec(flat))) return show(m.index, 'Intégrale');

  // Film : une année suivie d'indices de release (qualité, source, langue).
  for (const y of flat.matchAll(/\b(19[2-9]\d|20[0-4]\d)\b/g)) {
    if (y.index > 0 && MOVIE_HINT.test(flat.slice(y.index))) {
      const title = flat.slice(0, y.index).replace(/[\s\-–:([]+$/, '').trim();
      if (title) return { kind: 'movie', title, year: Number(y[1]), code: '' };
    }
  }
  return null;
}

// Nom lisible : « tulsa king » → « Tulsa King ».
export function prettyTitle(title) {
  return title === title.toLowerCase() ? title.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : title;
}

export function normalizeTitle(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const stripThe = (s) => s.replace(/^(the|le|la|les|l) /, '');

// Ressemblance de 0 à 100 entre deux titres.
function titleScore(a, b) {
  const x = stripThe(normalizeTitle(a));
  const y = stripThe(normalizeTitle(b));
  if (!x || !y) return 0;
  if (x === y) return 100;
  const ta = new Set(x.split(' '));
  const tb = new Set(y.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return Math.round((inter / new Set([...ta, ...tb]).size) * 90);
}

// Ce qu'il faut chercher pour une sortie, ou null si le nom ne dit rien.
// `type` vient du classement du flux : il sert quand le nom ne suffit pas.
export function posterQuery(item) {
  if (item.imdbId) return { key: `id|${item.imdbId}`, id: item.imdbId };
  let info = parseRelease(item.title);
  if (!info && (item.type === 'movie' || item.type === 'tv')) {
    const flat = flatten(item.title);
    const cut = flat.search(MOVIE_HINT);
    const title = (cut > 0 ? flat.slice(0, cut) : flat).replace(/[\s\-–:([]+$/, '').trim();
    if (title) info = { kind: item.type, ...cleanTitle(title) };
  }
  if (!info?.title) return null;
  const norm = normalizeTitle(info.title);
  if (norm.length < 2) return null;
  return { key: `${info.kind}|${norm}|${info.year || ''}`, kind: info.kind, title: info.title, year: info.year };
}

// --- IMDb ---------------------------------------------------------------------------

const TV = new Set(['tvSeries', 'tvMiniSeries']);
const MOVIE = new Set(['movie', 'tvMovie', 'video', 'tvSpecial']);

// Affiche en 300 px de large au lieu de l'original (souvent plusieurs Mo).
const resize = (url) => (url ? url.replace(/\._V1_.*\.(jpg|png)$/i, '._V1_QL75_UX300_.$1') : '');

async function suggest(query) {
  const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(query)}.json`, {
    credentials: 'omit',
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`IMDb : HTTP ${res.status}`);
  return (await res.json()).d || [];
}

// Le premier résultat du bon type, avec la bonne année quand on la connaît.
// IMDb trouve aussi les titres français (« Les Gouttes de Dieu » → « Drops of God »),
// d'où la place dans la liste qui compte autant que la ressemblance des titres.
function pick(results, q) {
  if (q.id) return results.find((x) => x.id === q.id);
  const types = q.kind === 'tv' ? TV : MOVIE;
  const cands = results
    .map((x, rank) => ({ x, rank, score: titleScore(q.title, x.l) }))
    .filter(({ x }) => types.has(x.qid));
  const plausible = (c) => c.score >= 60 || c.rank <= (q.kind === 'tv' ? 1 : 2);
  if (q.year) {
    const dated = cands.find((c) => Math.abs((c.x.y || 0) - q.year) <= 1 && (c.score >= 40 || c.rank <= 2));
    if (dated || q.kind === 'movie') return dated?.x;
  }
  return cands.find(plausible)?.x;
}

async function lookup(q) {
  const query = q.id || normalizeTitle(q.title).slice(0, 60);
  const found = pick(await suggest(query), q);
  return resize(found?.i?.imageUrl);
}

// --- Cache et file d'attente -----------------------------------------------------------

let cache = {}; // clé → [adresse de l'affiche ou '' si rien trouvé, date]
let loaded = null;
const pending = new Map();
const queue = [];
let active = 0;
let saveTimer;

export function loadPosterCache() {
  loaded ??= chrome.storage.local.get({ [CACHE_KEY]: {} }).then((r) => { cache = r[CACHE_KEY] || {}; });
  return loaded;
}

// Adresse connue, '' si IMDb n'a rien donné récemment, undefined s'il faut chercher.
export function cachedPoster(q) {
  const entry = cache[q.key];
  if (!entry || (!entry[0] && Date.now() - entry[1] > MISS_TTL)) return undefined;
  return entry[0];
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries = Object.entries(cache);
    if (entries.length > MAX_ENTRIES) {
      cache = Object.fromEntries(entries.sort((a, b) => b[1][1] - a[1][1]).slice(0, MAX_ENTRIES));
    }
    chrome.storage.local.set({ [CACHE_KEY]: cache });
  }, 1000);
}

function next() {
  while (active < CONCURRENCY && queue.length) {
    const { q, resolve } = queue.shift();
    active++;
    lookup(q).then((url) => {
      cache[q.key] = [url, Date.now()];
      saveSoon();
      resolve(url);
    }, () => resolve('')) // IMDb injoignable : rien en cache, on réessaiera.
      .finally(() => {
        pending.delete(q.key);
        active--;
        next();
      });
  }
}

// Cherche l'affiche (une seule fois par clé, quelques recherches à la fois).
export function findPoster(q) {
  if (!pending.has(q.key)) {
    pending.set(q.key, new Promise((resolve) => {
      queue.push({ q, resolve });
      next();
    }));
  }
  return pending.get(q.key);
}
