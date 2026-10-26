// Reconnaissance des noms de releases : série (saison, épisode), film, qualité, langue.

const QUALITY = [
  ['2160p', /\b(2160p|4k|uhd)\b/i],
  ['1080p', /\b1080[pi]\b/i],
  ['720p', /\b720p\b/i],
  ['sd', /\b(480p|576p|dvdrip|xvid)\b/i],
];

const LANGS = [
  ['multi', /\bmulti\b/i],
  ['vostfr', /\b(vostfr|subfrench|vost)\b/i],
  ['vf', /\b(truefrench|french|vff|vfq|vfi|vf2?)\b/i],
];

const MOVIE_HINT = /\b(2160p|1080p|720p|4k|uhd|bluray|blu-ray|bdrip|brrip|remux|web[- ]?dl|webrip|web|hdrip|dvdrip|hdtv|hdlight|x264|x265|h ?264|h ?265|hevc|av1|multi|french|truefrench|vostfr|vff)\b/i;

export const QUALITY_LABELS = { '2160p': '4K', '1080p': '1080p', '720p': '720p', sd: 'SD' };
export const LANG_LABELS = { multi: 'MULTi', vf: 'VF', vostfr: 'VOSTFR' };

function detect(list, s) {
  for (const [key, re] of list) if (re.test(s)) return key;
  return null;
}

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
  let t = raw.replace(/[\s\-–:([{]+$/, '').replace(/^[\s\-–]+/, '').trim();
  let year = null;
  const y = /\s\(?((?:19|20)\d{2})\)?$/.exec(t);
  if (y) {
    year = Number(y[1]);
    t = t.slice(0, y.index).trim();
  }
  return { title: t, year };
}

// Analyse un nom de release. Renvoie null si rien d'exploitable.
// kind : 'episode' | 'season' (pack d'une saison) | 'series' (plusieurs saisons) | 'movie'
export function parseRelease(name) {
  if (!name) return null;
  const flat = flatten(name);
  const quality = detect(QUALITY, flat);
  const lang = detect(LANGS, flat);
  const base = { quality, lang, raw: name };
  let m;

  const series = (index, extra) => {
    const { title, year } = cleanTitle(flat.slice(0, index));
    return title ? { ...base, title, year, ...extra } : null;
  };

  // S01-S04, S01-04 : plusieurs saisons.
  if ((m = /\bS(\d{1,2}) ?- ?S?(\d{1,2})\b/i.exec(flat))) return series(m.index, { kind: 'series', season: +m[1], seasonEnd: +m[2] });
  // S04E02, S04E02E03, S04E02-E03, S04E02-03
  if ((m = /\bS(\d{1,3}) ?E(\d{1,4})(?:-?E(\d{1,4})|-(\d{1,4}))?\b/i.exec(flat))) {
    const end = Number(m[3] || m[4]) || null;
    return series(m.index, { kind: 'episode', season: +m[1], episode: +m[2], episodeEnd: end });
  }
  // 4x02
  if ((m = /\b(\d{1,2})x(\d{2,3})\b/.exec(flat))) return series(m.index, { kind: 'episode', season: +m[1], episode: +m[2] });
  // Saison 4 Épisode 2 / Season 4 Episode 2 / Saison 4
  if ((m = /\b(?:saison|season|temporada|staffel) ?(\d{1,2})\b/i.exec(flat))) {
    // \b ne fonctionne pas devant « É » : on exige un début ou un espace.
    const ep = /(?:^|[\s-])(?:[ÉéEe]pisode|ep|e) ?(\d{1,3})\b/i.exec(flat.slice(m.index + m[0].length));
    return series(m.index, ep ? { kind: 'episode', season: +m[1], episode: +ep[1] } : { kind: 'season', season: +m[1] });
  }
  // S04 seul : pack de saison.
  if ((m = /\bS(\d{1,2})\b/i.exec(flat))) return series(m.index, { kind: 'season', season: +m[1] });
  // Intégrale / Complete
  if ((m = /\b(int[ée]grale|the complete series|complete series|complete)\b/i.exec(flat))) return series(m.index, { kind: 'series' });

  // Film : une année suivie d'indices de release (qualité, source, langue).
  const yearRe = /\b(19[2-9]\d|20[0-4]\d)\b/g;
  let lastYear = null;
  for (const y of flat.matchAll(yearRe)) {
    if (y.index > 0 && MOVIE_HINT.test(flat.slice(y.index))) { lastYear = y; break; }
  }
  if (lastYear) {
    const title = flat.slice(0, lastYear.index).replace(/[\s\-–([]+$/, '').trim();
    if (title) return { ...base, kind: 'movie', title, year: Number(lastYear[1]) };
  }
  return null;
}

// --- Comparaison de titres -----------------------------------------------------

export function normalizeTitle(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const stripYear = (s) => s.replace(/ (19|20)\d{2}$/, '').trim();
const stripThe = (s) => s.replace(/^(the|le|la|les) /, '');

// Score de 0 à 100 entre deux titres.
export function titleScore(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 100;
  const xs = stripYear(x);
  const ys = stripYear(y);
  if (xs === ys) return 96;
  if (stripThe(xs) === stripThe(ys)) return 92;
  const ta = new Set(stripThe(xs).split(' '));
  const tb = new Set(stripThe(ys).split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return Math.round((inter / new Set([...ta, ...tb]).size) * 85);
}

// --- Dossiers de saison --------------------------------------------------------

export function parseSeasonFolder(name) {
  const n = (name || '').trim();
  const m = /^(?:saison|season|staffel|temporada|stagione|series|s)[\s._-]*0*(\d{1,3})\b/i.exec(n);
  if (m) return Number(m[1]);
  if (/^(specials?|sp[ée]ciaux|bonus)$/i.test(n)) return 0;
  return null;
}

// Nom du dossier de saison : reprend le style des dossiers existants
// (« Saison 01 », « Season 3 », « S02 »…) ou, à défaut, le format choisi.
export function seasonFolderName(season, format = 'Saison {n}', siblings = []) {
  for (const s of siblings) {
    if (parseSeasonFolder(s) == null) continue;
    const m = /^(.*?)(\d+)\s*$/.exec(s.trim());
    if (!m) continue;
    const pad = m[2].length > 1 && m[2].startsWith('0') ? m[2].length : 1;
    return `${m[1]}${String(season).padStart(pad, '0')}`;
  }
  return (format || 'Saison {n}')
    .replace('{nn}', String(season).padStart(2, '0'))
    .replace('{n}', String(season));
}

// Titre propre pour créer un dossier : « tulsa king » → « Tulsa King ».
export function prettyTitle(title) {
  if (title !== title.toLowerCase()) return title;
  return title.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export function episodeCode(info) {
  if (!info) return '';
  const s = String(info.season ?? '').padStart(2, '0');
  if (info.kind === 'episode') {
    const e = String(info.episode).padStart(2, '0');
    return `S${s}E${e}${info.episodeEnd ? `-E${String(info.episodeEnd).padStart(2, '0')}` : ''}`;
  }
  if (info.kind === 'season') return `Saison ${info.season}`;
  if (info.kind === 'series') return info.seasonEnd ? `Saisons ${info.season} à ${info.seasonEnd}` : 'Intégrale';
  return '';
}
