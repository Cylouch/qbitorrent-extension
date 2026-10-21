// Réglages de l'extension, stockés dans chrome.storage.local.

export const DEFAULTS = {
  // Serveur
  serverUrl: '',
  username: 'admin',
  password: '',
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
  // Apparence
  theme: 'system', // 'system' | 'light' | 'dark'
  accent: 'blue',
  density: 'comfortable', // 'comfortable' | 'compact'
  animations: true,
  // Popup
  popupCount: 10,
  popupRefresh: 2,
  popupFilter: 'all',
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

// qBittorrent refuse les requêtes dont l'en-tête Origin/Referer ne correspond pas
// à son propre hôte (protection CSRF). Les requêtes d'une extension partent avec
// Origin: chrome-extension://…, donc on réécrit ces en-têtes pour l'API du serveur.
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
        urlFilter: `|${base}/api/v2/`,
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules,
  });
}
