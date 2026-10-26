// Synchronisation des réglages entre ordinateurs, via chrome.storage.sync :
// Chrome les transmet d'un PC à l'autre grâce au compte Google connecté au
// navigateur. Aucun serveur à installer.
//
// Limites de Chrome : 100 Ko au total, 8 Ko par élément. Les grosses valeurs
// (séries suivies…) sont donc découpées en morceaux, et les données
// recalculables (dates de diffusion, analyse des dossiers) ne sont pas envoyées.
import { DEFAULTS, getConfig } from './config.js';

const LOCAL_ONLY = new Set(['syncEnabled', 'syncSecrets', 'popupTab', 'popupFilter']);
const SECRETS = new Set(['password', 'token', 'feeds', 'indexers']);
// 8 Ko par élément, échappement JSON compris (chaque guillemet compte double) :
// 3 500 caractères laissent toujours de la marge.
const CHUNK = 3500;
const STATE_KEY = 'syncState';

export const SYNC_KEYS = Object.keys(DEFAULTS).filter((k) => !LOCAL_ONLY.has(k));

// JSON à clés triées : deux PC produisent exactement la même chaîne.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) | 0;
  return `${s.length}:${h >>> 0}`;
}

// Retire ce qui se recalcule sur chaque PC.
function slim(key, value) {
  if (key === 'followed') {
    return (value || []).map(({ next, previous, scheduleAt, summary, genres, language, ...s }) => ({
      ...s, aliases: (s.aliases || []).slice(0, 6),
    }));
  }
  if (key === 'movies') return (value || []).map(({ lastResult, lastSearch, ...m }) => m);
  return value;
}

// Réintègre ces champs locaux lors d'une réception.
function merge(key, incoming, local) {
  if (key !== 'followed' && key !== 'movies') return incoming;
  const byId = new Map((local || []).map((x) => [x.id, x]));
  return incoming.map((x) => ({ ...(byId.get(x.id) || {}), ...x }));
}

const allowed = (cfg, key) => SYNC_KEYS.includes(key) && (cfg.syncSecrets || !SECRETS.has(key));

async function loadState() {
  return (await chrome.storage.local.get({ [STATE_KEY]: {} }))[STATE_KEY];
}

// Envoie les clés modifiées sur ce PC.
export async function push(keys) {
  const cfg = await getConfig();
  if (!cfg.syncEnabled) return [];
  const state = await loadState();
  const remote = await chrome.storage.sync.get(null);
  const set = {};
  const remove = [];
  const sent = [];
  for (const key of keys) {
    if (!allowed(cfg, key)) continue;
    const json = canon(slim(key, cfg[key]));
    const h = hash(json);
    if (state[key] === h && remote[`m:${key}`]?.h === h) continue;
    const parts = [];
    for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
    set[`m:${key}`] = { n: parts.length, h, t: Date.now() };
    parts.forEach((p, i) => { set[`c:${key}:${i}`] = p; });
    for (let i = parts.length; i < (remote[`m:${key}`]?.n || 0); i++) remove.push(`c:${key}:${i}`);
    state[key] = h;
    sent.push(key);
  }
  if (!sent.length) return [];
  try {
    await chrome.storage.sync.set(set);
    if (remove.length) await chrome.storage.sync.remove(remove);
    await chrome.storage.local.set({ [STATE_KEY]: state, syncError: '' });
  } catch (e) {
    await chrome.storage.local.set({ syncError: e.message });
    throw e;
  }
  return sent;
}

// Récupère ce que les autres PC ont envoyé.
export async function pull() {
  const cfg = await getConfig();
  if (!cfg.syncEnabled) return [];
  const remote = await chrome.storage.sync.get(null);
  const state = await loadState();
  const patch = {};
  for (const key of SYNC_KEYS) {
    const meta = remote[`m:${key}`];
    if (!meta || meta.h === state[key] || !allowed(cfg, key)) continue;
    let json = '';
    for (let i = 0; i < meta.n; i++) {
      const part = remote[`c:${key}:${i}`];
      if (typeof part !== 'string') { json = null; break; }
      json += part;
    }
    // Écriture encore en cours sur l'autre PC : on réessaiera.
    if (json === null || hash(json) !== meta.h) continue;
    patch[key] = merge(key, JSON.parse(json), cfg[key]);
    state[key] = meta.h;
  }
  if (Object.keys(patch).length) {
    await chrome.storage.local.set({ [STATE_KEY]: state });
    await chrome.storage.local.set(patch);
  }
  return Object.keys(patch);
}

// Au démarrage : on récupère d'abord, puis on envoie seulement ce qui existe
// ici et pas encore là-bas. Un PC fraîchement installé n'écrase donc jamais
// les réglages des autres avec ses valeurs par défaut.
export async function reconcile() {
  const received = await pull();
  const stored = await chrome.storage.local.get(null);
  const remote = await chrome.storage.sync.get(null);
  const missing = SYNC_KEYS.filter((k) => k in stored && !remote[`m:${k}`]);
  const sent = missing.length ? await push(missing) : [];
  return { received, sent };
}

// Option « secrets » désactivée : on retire ce qui avait déjà été envoyé.
export async function dropSecrets() {
  const remote = await chrome.storage.sync.get(null);
  const keys = Object.keys(remote).filter((k) => SECRETS.has(k.replace(/^[mc]:/, '').replace(/:\d+$/, '')));
  if (keys.length) await chrome.storage.sync.remove(keys);
  const state = await loadState();
  SECRETS.forEach((k) => delete state[k]);
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

export async function syncStatus() {
  const [bytes, local] = await Promise.all([
    chrome.storage.sync.getBytesInUse(null).catch(() => 0),
    chrome.storage.local.get({ syncError: '' }),
  ]);
  return { bytes, quota: chrome.storage.sync.QUOTA_BYTES || 102400, error: local.syncError };
}

// Copie complète des réglages dans un fichier (sauvegarde, ou PC sans compte Google).
// Sans `secrets` : ni mots de passe, ni flux (leur adresse contient la passkey), ni clés API.
export async function exportSettings({ secrets = false } = {}) {
  const cfg = await getConfig();
  const settings = { ...cfg };
  if (!secrets) {
    delete settings.password;
    delete settings.token;
    delete settings.feeds;
    settings.indexers = (cfg.indexers || []).map((ix) => ({ ...ix, apikey: '' }));
  }
  return { app: 'Torrent Connect', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), secrets, settings };
}

// Réglages à appliquer depuis une sauvegarde. Une clé API absente du fichier
// garde celle déjà enregistrée pour le même indexeur.
export function importableKeys(data, current = {}) {
  const settings = data?.settings && typeof data.settings === 'object' ? data.settings : null;
  if (!settings) throw new Error("Ce fichier n'est pas une sauvegarde de Torrent Connect.");
  const patch = Object.fromEntries(Object.entries(settings).filter(([k]) => k in DEFAULTS && !LOCAL_ONLY.has(k)));
  if (Array.isArray(patch.indexers)) {
    patch.indexers = patch.indexers.map((ix) => ({
      ...ix, apikey: ix.apikey || (current.indexers || []).find((x) => x.url === ix.url)?.apikey || '',
    }));
  }
  return patch;
}
