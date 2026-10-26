// Recherche de films sur IMDb, via le service de suggestions utilisé par la
// barre de recherche du site (sans clé). Service non officiel : s'il change,
// seule la recherche de films est touchée.

const resize = (url) => (url ? url.replace(/\._V1_.*\.(jpg|png)$/i, '._V1_QL75_UX300_.$1') : '');

export async function searchMovies(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`IMDb : HTTP ${res.status}`);
  const { d = [] } = await res.json();
  return d
    .filter((x) => /^tt\d+$/.test(x.id) && (x.qid === 'movie' || x.qid === 'tvMovie' || x.q === 'feature'))
    .map((x) => ({
      id: x.id,
      title: x.l,
      year: x.y || null,
      poster: resize(x.i?.imageUrl),
      cast: x.s || '',
      url: `https://www.imdb.com/title/${x.id}/`,
    }));
}
