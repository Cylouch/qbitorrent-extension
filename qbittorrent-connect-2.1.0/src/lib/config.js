// Réglages de l'extension, stockés dans chrome.storage.local.

export const DEFAULTS = {
  // Client torrent
  client: 'qbittorrent',
  serverUrl: '',
  username: 'admin',
  password: '',
  rpcPath: '',
  token: '',
  // Interception
  interceptTorrents: true,
  interceptMagnets: true,
  deleteLocalTorrent: true,
  // Ajout
  addMode: 'dialog', // 'dialog' | 'direct'
  windowSize: 'normal', // 'normal' | 'large'
  rememberLastPath: false,
  closeAfterAdd: true,
  notifications: true,
  defaultCategory: '',
  recentPaths: [],
  // Rangement automatique
  autoOrganize: true,
  seriesRoot: '',
  moviesRoot: '',
  seasonFormat: 'Saison {n}',
  flattenEpisodes: true,
  movieSubfolder: false,
  seriesCategory: '',
  moviesCategory: '',
  // Alertes de sorties
  alertsEnabled: true,
  feeds: [], // [{ id, name, url, enabled }]
  indexers: [], // indexeurs Torznab : [{ id, name, url, apikey, enabled }]
  followed: [], // séries suivies, voir lib/tvmaze.js
  movies: [], // films suivis, voir lib/imdb.js
  checkInterval: 30,
  wantedInterval: 120, // recherche des épisodes et films manquants (minutes)
  alertDisplay: 'both', // 'banner' | 'notification' | 'both'
  // Profil de qualité (voir lib/quality.js)
  profile: {},
  // Synchronisation entre ordinateurs (compte Google de Chrome)
  syncEnabled: true,
  syncSecrets: true,
  // Apparence
  theme: 'system', // 'system' | 'light' | 'dark'
  accent: 'blue',
  density: 'comfortable', // 'comfortable' | 'compact'
  animations: true,
  // Popup
  popupCount: 10,
  popupRefresh: 2,
  popupFilter: 'all',
  popupTab: 'torrents',
};

export async function getConfig() {
  return chrome.storage.local.get(DEFAULTS);
}

export async function setConfig(patch) {
  await chrome.storage.local.set(patch);
  if ('serverUrl' in patch) await applyHeaderRule(patch.serverUrl);
}

export function normalizeUrl(url) {
  url = (url || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

// Beaucoup de clients (qBittorrent en tête) refusent les requêtes dont l'en-tête
// Origin ne correspond pas à leur propre adresse (protection CSRF). Les requêtes
// d'une extension partent avec Origin: chrome-extension://…, donc on réécrit ces
// en-têtes pour le seul serveur configuré, et uniquement pour les requêtes de
// l'extension : un site web ne doit jamais profiter de cette réécriture pour
// contourner la protection CSRF du client.
const HEADER_RULE_ID = 1;

export async function applyHeaderRule(serverUrl) {
  const addRules = [];
  const base = normalizeUrl(serverUrl);
  if (base) {
    const origin = new URL(base).origin;
    addRules.push({
      id: HEADER_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: origin },
          { header: 'referer', operation: 'set', value: `${base}/` },
        ],
      },
      condition: {
        urlFilter: `|${origin}/`,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules,
  });
}
