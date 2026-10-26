// TVmaze : fiches de séries, affiches, titres alternatifs et prochains épisodes.
// API publique et gratuite, sans clé : https://www.tvmaze.com/api
// Limite : environ 20 appels toutes les 10 secondes par adresse IP.

const API = 'https://api.tvmaze.com';

async function get(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`);
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TVmaze : HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('TVmaze : trop de requêtes, réessaie dans un instant.');
}

const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, '').trim();

export function toShow(s) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    year: s.premiered ? Number(s.premiered.slice(0, 4)) : null,
    status: s.status || '',
    network: s.network?.name || s.webChannel?.name || '',
    language: s.language || '',
    genres: s.genres || [],
    poster: s.image?.medium || s.image?.original || '',
    imdb: s.externals?.imdb || '',
    url: s.url || '',
    summary: stripHtml(s.summary).slice(0, 400),
  };
}

export async function searchShows(query) {
  const r = await get(`/search/shows?q=${encodeURIComponent(query)}`);
  return (r || []).map((x) => toShow(x.show));
}

// Meilleure correspondance pour un titre (pour l'affiche dans la fenêtre d'ajout).
// TVmaze ne trouve rien si l'année est dans la recherche (« Tulsa King (2022) »).
export async function findShow(title) {
  const q = title.replace(/\s*\(?(19|20)\d{2}\)?\s*$/, '').trim();
  return toShow(await get(`/singlesearch/shows?q=${encodeURIComponent(q)}`));
}

export async function lookupImdb(imdbId) {
  return toShow(await get(`/lookup/shows?imdb=${encodeURIComponent(imdbId)}`));
}

// Titres alternatifs (titre français, etc.), utiles pour reconnaître les releases.
export async function akas(id) {
  const r = await get(`/shows/${id}/akas`);
  return [...new Set((r || []).map((a) => a.name).filter(Boolean))];
}

// Tous les épisodes (hors épisodes spéciaux) : { season, number, name, airdate }.
export async function episodes(id) {
  const r = await get(`/shows/${id}/episodes`);
  return (r || [])
    .filter((e) => e.season > 0 && e.number != null)
    .map((e) => ({ season: e.season, number: e.number, name: e.name || '', airdate: e.airdate || '' }));
}

const episode = (e) => (e ? { season: e.season, number: e.number, name: e.name || '', airdate: e.airdate || '', airstamp: e.airstamp || '' } : null);

// Épisodes précédent et suivant.
export async function schedule(id) {
  const s = await get(`/shows/${id}?embed[]=nextepisode&embed[]=previousepisode`);
  return {
    status: s?.status || '',
    next: episode(s?._embedded?.nextepisode),
    previous: episode(s?._embedded?.previousepisode),
  };
}
