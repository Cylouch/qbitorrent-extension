// Recherche sur les indexeurs Torznab (C411, Jackett, Prowlarr…).
// Un indexeur Torznab répond au format RSS : on réutilise le lecteur de flux.
import { parseFeed, feedError } from './rss.js';
import { rankReleases, matchesEpisode, matchesSeason, matchesMovie, profileOf } from './quality.js';

export const PRESETS = {
  c411: { name: 'C411', url: 'https://c411.org/api/torznab' },
};

const CAT_TV = '5000';
const CAT_MOVIES = '2000';

export function indexerUrl(ix, params) {
  const qs = new URLSearchParams({ ...params, limit: '100', apikey: ix.apikey || '' });
  return `${ix.url.replace(/[?&]+$/, '')}${ix.url.includes('?') ? '&' : '?'}${qs}`;
}

export async function query(ix, params) {
  const res = await fetch(indexerUrl(ix, params), { credentials: 'omit', cache: 'no-store' });
  const body = await res.text();
  if (!res.ok) throw new Error(`${ix.name} : ${feedError(res.status, body)}`);
  const err = /<error[^>]*description=["']([^"']+)["']/i.exec(body);
  if (err) throw new Error(`${ix.name} : ${err[1]}`);
  return parseFeed(body).items.map((i) => ({ ...i, indexer: ix.name }));
}

const active = (cfg) => (cfg.indexers || []).filter((ix) => ix.enabled !== false && ix.url && ix.apikey);

export const hasIndexer = (cfg) => active(cfg).length > 0;

// Interroge tous les indexeurs actifs ; une erreur sur l'un n'arrête pas les autres.
async function searchAll(cfg, params) {
  const results = await Promise.allSettled(active(cfg).map((ix) => query(ix, params)));
  const items = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push(r.reason.message);
  }
  // Une même release peut venir de deux indexeurs.
  const seen = new Set();
  return {
    items: items.filter((i) => (seen.has(i.title) ? false : seen.add(i.title))),
    errors,
  };
}

const showNames = (show) => [show.name, ...(show.aliases || [])];

// Meilleure release pour un épisode, selon le profil de qualité.
export async function findEpisode(cfg, show, season, episode) {
  const { items, errors } = await searchAll(cfg, { t: 'tvsearch', q: show.name, season: String(season), ep: String(episode), cat: CAT_TV });
  let matching = items.filter((i) => matchesEpisode(i, showNames(show), season, episode));
  // Certains indexeurs ignorent season/ep : on refait une recherche plus large.
  if (!matching.length && !errors.length) {
    const wide = await searchAll(cfg, { t: 'search', q: `${show.name} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`, cat: CAT_TV });
    matching = wide.items.filter((i) => matchesEpisode(i, showNames(show), season, episode));
  }
  return { ...rankReleases(filterLang(matching, show.lang), profileOf(cfg)), errors, total: items.length };
}

// Pack complet d'une saison. L'écart accepté pour la Compact vaut par épisode.
export async function findSeason(cfg, show, season, episodes = 1) {
  const { items, errors } = await searchAll(cfg, { t: 'tvsearch', q: show.name, season: String(season), cat: CAT_TV });
  const matching = items.filter((i) => matchesSeason(i, showNames(show), season));
  const profile = profileOf(cfg);
  profile.compactMargin *= Math.max(1, episodes);
  return { ...rankReleases(filterLang(matching, show.lang), profile), errors, total: items.length };
}

export async function findMovie(cfg, movie) {
  let byId = { items: [], errors: [] };
  if (movie.id?.startsWith('tt')) byId = await searchAll(cfg, { t: 'movie', imdbid: movie.id.slice(2), cat: CAT_MOVIES });
  let matching = byId.items.filter((i) => matchesMovie(i, movie.title, movie.year, { trustId: true }));
  let { errors } = byId;
  if (!matching.length) {
    const byName = await searchAll(cfg, { t: 'movie', q: `${movie.title}${movie.year ? ` ${movie.year}` : ''}`, cat: CAT_MOVIES });
    matching = byName.items.filter((i) => matchesMovie(i, movie.title, movie.year));
    errors = [...new Set([...errors, ...byName.errors])];
  }
  return { ...rankReleases(filterLang(matching, movie.lang), profileOf(cfg)), errors, total: matching.length };
}

// Filtre de langue : une release MULTi contient la VF.
function filterLang(items, lang) {
  if (!lang || lang === 'any') return items;
  return items.filter((i) => {
    const l = /\bmulti\b/i.test(i.title) ? 'multi'
      : /\b(vostfr|subfrench|vost)\b/i.test(i.title) ? 'vostfr'
        : /\b(truefrench|french|vff|vfq|vfi|vf2?)\b/i.test(i.title) ? 'vf' : null;
    return lang === 'vf' ? l === 'vf' || l === 'multi' : l === lang;
  });
}

// Vérifie un indexeur : capacités (sans clé), puis une recherche avec la clé.
export async function testIndexer(ix) {
  const caps = await fetch(`${ix.url}${ix.url.includes('?') ? '&' : '?'}t=caps`, { credentials: 'omit' });
  const capsText = await caps.text();
  const title = /<server[^>]*title=["']([^"']+)["']/i.exec(capsText)?.[1] || ix.name;
  const items = await query(ix, { t: 'search', q: 'test', cat: CAT_TV });
  return { title, count: items.length };
}
