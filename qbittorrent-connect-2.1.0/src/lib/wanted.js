// Ce qui manque : épisodes diffusés absents de la bibliothèque, films suivis
// pas encore téléchargés. Façon Sonarr / Radarr, en beaucoup plus simple.
import { getConfig, setConfig } from './config.js';
import { createClient } from './clients/index.js';
import { episodes as tvEpisodes } from './tvmaze.js';
import { findSeriesFolder, scanSeries, episodeStatus, findMovieInLibrary } from './library.js';
import { findEpisode, findMovie, hasIndexer } from './indexer.js';

const RECENT_DAYS = 21;
const MAX_PER_SHOW = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const epKey = (season, episode) => `${season}x${episode}`;

// État complet d'une série : dossier, saisons, épisodes présents / manquants / à venir.
export async function seriesStatus(client, cfg, show) {
  const eps = await tvEpisodes(show.id);
  let folder = null;
  let have = new Map();
  let library = 'unavailable';
  if (client?.caps.library && (cfg.seriesRoot || show.folder)) {
    try {
      // Dossier choisi à la main, sinon recherche dans le dossier des séries.
      folder = show.folder
        ? { path: show.folder, name: show.folder.split(/[\\/]/).filter(Boolean).pop() }
        : await findSeriesFolder(client, cfg, show);
      if (folder) ({ have } = await scanSeries(client, folder.path));
      library = folder ? 'ok' : 'no-folder';
    } catch {
      library = 'error';
    }
  }
  const grabbed = new Set(show.grabbed || []);
  const seasons = episodeStatus(eps, have).map((s) => {
    const episodes = s.episodes.map((e) => (e.state === 'missing' && grabbed.has(epKey(s.season, e.number)) ? { ...e, state: 'grabbed' } : e));
    return { ...s, episodes, missing: episodes.filter((e) => e.state === 'missing').length, grabbed: episodes.filter((e) => e.state === 'grabbed').length };
  });
  const status = { folder, library, seasons, at: Date.now() };
  await saveSummary(show.id, status);
  return status;
}

// Résumé par saison, gardé pour afficher les cartes sans tout recalculer.
export function summarize(status) {
  return {
    at: status.at,
    library: status.library,
    folder: status.folder?.path || '',
    seasons: status.seasons.map((s) => ({
      season: s.season, total: s.episodes.length, have: s.have, missing: s.missing, upcoming: s.upcoming, grabbed: s.grabbed,
    })),
  };
}

async function saveSummary(id, status) {
  const { libraryCache = {} } = await chrome.storage.local.get('libraryCache');
  libraryCache[id] = summarize(status);
  await chrome.storage.local.set({ libraryCache });
}

// Enregistre un épisode ou un film comme envoyé, sans écraser les modifications faites entre-temps.
// `episodes` : liste d'épisodes pour un pack de saison.
export async function markGrabbed({ showId, season, episode, episodes, movieId, title }) {
  const cfg = await getConfig();
  const eps = episodes || (episode != null ? [episode] : []);
  if (showId != null && eps.length) {
    await setConfig({
      followed: cfg.followed.map((s) => (s.id === showId
        ? { ...s, grabbed: [...new Set([...(s.grabbed || []), ...eps.map((e) => epKey(season, e))])].slice(-300) }
        : s)),
    });
  }
  if (movieId) {
    await setConfig({
      movies: cfg.movies.map((m) => (m.id === movieId ? { ...m, status: 'grabbed', grabbedAt: Date.now(), grabbedTitle: title } : m)),
    });
  }
}

// Passe en revue séries et films. `decide(found)` reçoit chaque release trouvée :
// { kind: 'episode' | 'movie', show?, movie?, season?, episode?, best, auto }.
export async function runWanted(decide) {
  const cfg = await getConfig();
  const report = { checked: 0, found: 0, errors: [] };
  if (!hasIndexer(cfg) || !cfg.serverUrl) return report;
  const client = createClient(cfg);
  const today = new Date();
  const since = new Date(today.getTime() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const proposed = new Set((await chrome.storage.local.get({ proposedKeys: [] })).proposedKeys);

  // Séries : épisodes récents manquants, diffusés après le début du suivi.
  for (const show of cfg.followed) {
    report.checked++;
    let status;
    try {
      status = await seriesStatus(client, cfg, show);
    } catch (e) {
      report.errors.push(`${show.name} : ${e.message}`);
      continue;
    }
    const followedSince = new Date(show.addedAt || 0).toISOString().slice(0, 10);
    const wanted = status.seasons
      .flatMap((s) => s.episodes.filter((e) => e.state === 'missing').map((e) => ({ season: s.season, ...e })))
      .filter((e) => e.airdate >= since && e.airdate >= followedSince)
      .slice(-MAX_PER_SHOW);
    for (const ep of wanted) {
      const key = `ep:${show.id}:${epKey(ep.season, ep.number)}`;
      if (!show.autoDownload && proposed.has(key)) continue;
      try {
        const r = await findEpisode(cfg, show, ep.season, ep.number);
        if (r.errors.length) report.errors.push(...r.errors);
        if (r.best) {
          report.found++;
          proposed.add(key);
          await decide({ kind: 'episode', show, season: ep.season, episode: ep.number, best: r.best, auto: Boolean(show.autoDownload) });
        }
      } catch (e) {
        report.errors.push(`${show.name} : ${e.message}`);
      }
      await sleep(1500);
    }
  }

  // Films suivis pas encore récupérés.
  for (const movie of cfg.movies.filter((m) => m.status !== 'grabbed' && m.status !== 'library')) {
    report.checked++;
    try {
      if (await findMovieInLibrary(client, cfg, movie).catch(() => null)) {
        await setMovie(movie.id, { status: 'library' });
        continue;
      }
      const r = await findMovie(cfg, movie);
      if (r.errors.length) report.errors.push(...r.errors);
      await setMovie(movie.id, { lastSearch: Date.now(), lastResult: r.best ? r.best.label : '' });
      const key = `movie:${movie.id}`;
      if (r.best && (movie.autoDownload !== false || !proposed.has(key))) {
        report.found++;
        proposed.add(key);
        await decide({ kind: 'movie', movie, best: r.best, auto: movie.autoDownload !== false });
      }
    } catch (e) {
      report.errors.push(`${movie.title} : ${e.message}`);
    }
    await sleep(1500);
  }

  await chrome.storage.local.set({ proposedKeys: [...proposed].slice(-1000), wantedReport: { ...report, at: Date.now() } });
  return report;
}

async function setMovie(id, patch) {
  const cfg = await getConfig();
  await setConfig({ movies: cfg.movies.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
}
