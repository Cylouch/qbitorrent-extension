// Bibliothèque : ce que tu possèdes déjà sur le serveur.
//
// Pour une série : retrouve son dossier, parcourt les dossiers de saison et
// repère les épisodes présents d'après les noms de fichiers, puis compare avec
// la liste des épisodes diffusés (TVmaze).
import { parseRelease, parseSeasonFolder, titleScore } from './media.js';

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|m2ts|mov|wmv|webm)$/i;
const MAX_DEPTH = 3;

// Saison et épisode(s) d'un nom de fichier, même sans titre (« S04E02.mkv », « Episode 2.mkv »).
export function episodeNumbers(name) {
  const flat = name.replace(VIDEO, '').replace(/[._]+/g, ' ');
  let m = /\bS(\d{1,3}) ?E(\d{1,4})(?:-?E(\d{1,4})|-(\d{1,4}))?\b/i.exec(flat);
  if (m) return { season: +m[1], episode: +m[2], episodeEnd: Number(m[3] || m[4]) || null };
  m = /\b(\d{1,2})x(\d{2,3})\b/.exec(flat);
  if (m) return { season: +m[1], episode: +m[2], episodeEnd: null };
  m = /(?:^|[\s-])(?:[ÉéEe]pisode|ep|e)\s?0*(\d{1,3})\b/i.exec(flat);
  if (m) return { season: null, episode: +m[1], episodeEnd: null };
  return null;
}

function add(have, season, n) {
  if (season == null || n == null) return;
  if (!have.has(season)) have.set(season, new Set());
  for (let e = n.episode; e <= (n.episodeEnd || n.episode); e++) have.get(season).add(e);
}

export async function findSeriesFolder(client, cfg, show) {
  if (!client.caps.library || !cfg.seriesRoot) return null;
  const entries = await client.listAll(cfg.seriesRoot);
  let best = null;
  for (const d of entries.filter((e) => e.type !== 'file')) {
    for (const name of [show.name, ...(show.aliases || [])]) {
      const score = titleScore(d.name, name);
      if (score >= 75 && (!best || score > best.score)) best = { ...d, score };
    }
  }
  return best;
}

// { have: Map<saison, Set<épisode>>, files }
export async function scanSeries(client, path) {
  const have = new Map();
  let files = 0;
  const walk = async (dir, season, depth) => {
    const entries = await client.listAll(dir).catch(() => []);
    for (const e of entries) {
      if (e.type === 'file') {
        if (!VIDEO.test(e.name) || /sample/i.test(e.name)) continue;
        files++;
        const n = episodeNumbers(e.name);
        if (n) add(have, n.season ?? season, n);
      } else if (depth < MAX_DEPTH) {
        // Dossier de saison (« Saison 4 ») ou dossier d'un torrent (« Show.S04.MULTi… »).
        const s = parseSeasonFolder(e.name) ?? parseRelease(e.name)?.season ?? season;
        await walk(e.path, s, depth + 1);
      }
    }
  };
  await walk(path, null, 0);
  return { have, files };
}

// Compare la liste TVmaze à ce qui est présent. Par saison :
// { season, episodes: [{ number, name, airdate, state: 'have' | 'missing' | 'upcoming' }], have, missing, upcoming, complete }
export function episodeStatus(episodes, have, today = new Date().toISOString().slice(0, 10)) {
  const seasons = new Map();
  for (const ep of episodes) {
    if (!seasons.has(ep.season)) seasons.set(ep.season, { season: ep.season, episodes: [] });
    const owned = have.get(ep.season)?.has(ep.number) || false;
    const aired = Boolean(ep.airdate) && ep.airdate <= today;
    seasons.get(ep.season).episodes.push({ ...ep, state: owned ? 'have' : aired ? 'missing' : 'upcoming' });
  }
  return [...seasons.values()].sort((a, b) => a.season - b.season).map((s) => {
    const count = (st) => s.episodes.filter((e) => e.state === st).length;
    const result = { ...s, have: count('have'), missing: count('missing'), upcoming: count('upcoming') };
    result.complete = result.missing === 0 && result.upcoming === 0 && result.have > 0;
    return result;
  });
}

// Le film est-il déjà dans le dossier des films ?
export async function findMovieInLibrary(client, cfg, movie) {
  if (!client.caps.library || !cfg.moviesRoot) return null;
  const entries = await client.listAll(cfg.moviesRoot).catch(() => []);
  for (const e of entries) {
    const name = e.name.replace(VIDEO, '');
    const info = parseRelease(name);
    const yearMatch = /\b((?:19|20)\d{2})\b/.exec(name);
    const title = info?.kind === 'movie'
      ? info.title
      : name.replace(/[._]+/g, ' ').replace(/\s*\(?\b(?:19|20)\d{2}\b\)?.*$/, '').trim();
    const year = info?.year ?? (yearMatch ? Number(yearMatch[1]) : null);
    if (titleScore(title, movie.title) >= 85 && (!year || !movie.year || Math.abs(year - movie.year) <= 1)) return e;
  }
  return null;
}
