// Alertes de sorties : surveille les flux RSS et repère les nouveaux épisodes
// des séries suivies.
import { getConfig, setConfig } from './config.js';
import { parseFeed, feedError } from './rss.js';
import { parseRelease, titleScore, episodeCode } from './media.js';
import { schedule } from './tvmaze.js';
import { indexerUrl } from './indexer.js';

const KEY_ALERTS = 'releaseAlerts';
const KEY_SEEN = 'seenGuids';
const KEY_STATE = 'feedState';
const MAX_ALERTS = 150;
const MAX_SEEN = 4000;
const MIN_SCORE = 90;
const SCHEDULE_TTL = 12 * 3600 * 1000;

export async function loadAlerts() {
  const r = await chrome.storage.local.get({ [KEY_ALERTS]: [] });
  return r[KEY_ALERTS];
}

async function saveAlerts(alerts) {
  await chrome.storage.local.set({ [KEY_ALERTS]: alerts.slice(0, MAX_ALERTS) });
  await updateBadge(alerts);
}

export async function feedState() {
  return (await chrome.storage.local.get({ [KEY_STATE]: {} }))[KEY_STATE];
}

export async function updateBadge(alerts) {
  const list = alerts || await loadAlerts();
  const unread = list.filter((a) => !a.read).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  await chrome.action.setBadgeText({ text: unread ? String(Math.min(unread, 99)) : '' });
}

// Un élément de flux correspond-il à une série suivie (avec ses filtres) ?
export function matchItem(item, followed) {
  const info = parseRelease(item.title);
  if (!info || !['episode', 'season', 'series'].includes(info.kind)) return null;
  let best = null;
  for (const show of followed) {
    for (const name of [show.name, ...(show.aliases || [])]) {
      const score = titleScore(name, info.title);
      if (score >= MIN_SCORE && (!best || score > best.score)) best = { show, score };
    }
  }
  if (!best) return null;
  const { show } = best;
  if (show.quality && show.quality !== 'any' && info.quality !== show.quality) return null;
  if (show.lang && show.lang !== 'any') {
    // Une release MULTi contient la VF.
    const ok = show.lang === 'vf' ? ['vf', 'multi'].includes(info.lang) : info.lang === show.lang;
    if (!ok) return null;
  }
  return { show, info };
}

// Un élément de flux correspond-il à un film suivi pas encore récupéré ?
export function matchMovie(item, movies) {
  const info = parseRelease(item.title);
  if (!info || info.kind !== 'movie') return null;
  const movie = movies.find((m) => m.status !== 'grabbed' && m.status !== 'library'
    && titleScore(m.title, info.title) >= 90
    && (!m.year || !info.year || Math.abs(m.year - info.year) <= 1));
  if (!movie) return null;
  if (movie.lang && movie.lang !== 'any') {
    const ok = movie.lang === 'vf' ? ['vf', 'multi'].includes(info.lang) : info.lang === movie.lang;
    if (!ok) return null;
  }
  return { movie, info };
}

// Ajoute des alertes créées ailleurs (épisodes manquants, films trouvés) ; ignore les doublons.
export async function addAlerts(list) {
  const alerts = await loadAlerts();
  const added = [];
  for (const a of list) {
    if (alerts.some((x) => x.key === a.key)) continue;
    alerts.unshift(a);
    added.push(a);
  }
  if (added.length) await saveAlerts(alerts);
  return added;
}

const release = (item, info) => ({
  title: item.title,
  link: item.link,
  torrentUrl: item.torrentUrl,
  quality: info.quality,
  lang: info.lang,
  size: item.size,
});

// Lit tous les flux actifs. Renvoie les nouvelles alertes et les erreurs.
export async function checkFeeds() {
  const cfg = await getConfig();
  // Les indexeurs Torznab servent aussi de flux : leurs dernières sorties TV et films.
  const feeds = [
    ...cfg.feeds.filter((f) => f.enabled !== false && f.url),
    ...(cfg.indexers || []).filter((ix) => ix.enabled !== false && ix.url && ix.apikey).map((ix) => ({
      id: `ix-${ix.id}`, name: ix.name, url: indexerUrl(ix, { t: 'search', cat: '5000,2000' }), indexer: true,
    })),
  ];
  if (!feeds.length) return { fresh: [], errors: [], checked: 0 };

  const store = await chrome.storage.local.get({ [KEY_ALERTS]: [], [KEY_SEEN]: [], [KEY_STATE]: {} });
  const seen = new Set(store[KEY_SEEN]);
  const state = store[KEY_STATE];
  const alerts = store[KEY_ALERTS];
  const fresh = [];
  const errors = [];

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(feedError(res.status, await res.text().catch(() => '')));
      const { items } = parseFeed(await res.text());
      if (!items.length && !state[feed.id] && !feed.indexer) throw new Error("aucun élément trouvé : est-ce bien un flux RSS ?");

      for (const item of items) {
        const seenKey = `${feed.id}|${item.guid}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        const match = matchItem(item, cfg.followed);
        if (!match) {
          const mm = matchMovie(item, cfg.movies || []);
          if (!mm) continue;
          const key = `movie:${mm.movie.id}`;
          const existing = alerts.find((a) => a.key === key);
          if (existing) {
            if (!existing.releases.some((r) => r.title === item.title)) existing.releases.push(release(item, mm.info));
            continue;
          }
          const alert = {
            id: crypto.randomUUID(),
            key,
            kind: 'movie',
            movieId: mm.movie.id,
            showName: `${mm.movie.title}${mm.movie.year ? ` (${mm.movie.year})` : ''}`,
            poster: mm.movie.poster || '',
            code: 'Film',
            ...release(item, mm.info),
            feedName: feed.name || 'Flux RSS',
            pubDate: item.pubDate,
            foundAt: Date.now(),
            read: false,
            shown: false,
            downloaded: false,
            autoDownload: mm.movie.autoDownload !== false,
            releases: [release(item, mm.info)],
          };
          alerts.unshift(alert);
          fresh.push(alert);
          continue;
        }
        const { show, info } = match;
        // Seules les sorties postérieures au suivi de la série déclenchent une alerte.
        if (!item.pubDate ? !state[feed.id] : item.pubDate < (show.addedAt || 0)) continue;

        const key = `${show.id}:${info.kind}:${info.season ?? ''}:${info.episode ?? ''}`;
        const existing = alerts.find((a) => a.key === key);
        if (existing) {
          // Même épisode, autre release : on l'ajoute sans nouvelle alerte.
          if (!existing.releases.some((r) => r.title === item.title)) existing.releases.push(release(item, info));
          continue;
        }
        const alert = {
          id: crypto.randomUUID(),
          key,
          showId: show.id,
          showName: show.name,
          poster: show.poster || '',
          kind: info.kind,
          season: info.season ?? null,
          episode: info.episode ?? null,
          code: episodeCode(info),
          ...release(item, info),
          feedName: feed.name || 'Flux RSS',
          pubDate: item.pubDate,
          foundAt: Date.now(),
          read: false,
          shown: false,
          downloaded: false,
          autoDownload: Boolean(show.autoDownload),
          releases: [release(item, info)],
        };
        alerts.unshift(alert);
        fresh.push(alert);
      }
      state[feed.id] = { lastCheck: Date.now(), count: items.length, error: null };
    } catch (e) {
      state[feed.id] = { ...(state[feed.id] || {}), lastCheck: Date.now(), error: e.message };
      errors.push({ feed: feed.name || feed.url, error: e.message });
    }
  }

  await chrome.storage.local.set({
    [KEY_SEEN]: [...seen].slice(-MAX_SEEN),
    [KEY_STATE]: state,
  });
  await saveAlerts(alerts);
  return { fresh, errors, checked: feeds.length };
}

export async function updateAlert(id, patch) {
  const alerts = await loadAlerts();
  const a = alerts.find((x) => x.id === id);
  if (a) Object.assign(a, patch);
  await saveAlerts(alerts);
  return a;
}

export async function markAll(patch) {
  const alerts = await loadAlerts();
  alerts.forEach((a) => Object.assign(a, patch));
  await saveAlerts(alerts);
}

export async function clearAlerts() {
  await saveAlerts([]);
}

// Alertes pas encore affichées dans une page (de moins de 3 jours).
export async function takePending() {
  const alerts = await loadAlerts();
  const limit = Date.now() - 3 * 86400 * 1000;
  const pending = alerts.filter((a) => !a.shown && a.foundAt > limit);
  if (pending.length) {
    pending.forEach((a) => { a.shown = true; });
    await saveAlerts(alerts);
  }
  return pending;
}

// Met à jour les dates des prochains épisodes (TVmaze), au plus toutes les 12 h.
export async function refreshSchedules(force = false) {
  const cfg = await getConfig();
  let changed = false;
  for (const show of cfg.followed) {
    if (!force && show.scheduleAt && Date.now() - show.scheduleAt < SCHEDULE_TTL) continue;
    try {
      const s = await schedule(show.id);
      Object.assign(show, { next: s.next, previous: s.previous, status: s.status || show.status, scheduleAt: Date.now() });
      changed = true;
    } catch { /* on réessaiera plus tard */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (changed) {
    // Relit la config : l'utilisateur a pu modifier la liste pendant ce temps.
    const latest = await getConfig();
    const byId = new Map(cfg.followed.map((s) => [s.id, s]));
    await setConfig({
      followed: latest.followed.map((s) => (byId.has(s.id) ? { ...s, ...pick(byId.get(s.id)) } : s)),
    });
  }
}

const pick = (s) => ({ next: s.next, previous: s.previous, status: s.status, scheduleAt: s.scheduleAt });
