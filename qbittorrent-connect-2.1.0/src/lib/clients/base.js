// Socle commun à tous les clients torrent.
//
// Chaque client expose la même interface ; la fenêtre d'ajout, la popup et le
// service d'arrière-plan ne connaissent que celle-ci. `caps` indique ce que le
// client sait faire, pour masquer les options qu'il ne gère pas.

export class ClientError extends Error {
  constructor(message, code = 'ERROR', status) {
    super(message);
    this.name = 'ClientError';
    this.code = code;
    this.status = status;
  }
}

export const unsupported = (what) => new ClientError(`${what} n'est pas pris en charge par ce client.`, 'UNSUPPORTED');

export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function basicAuth(user, pass) {
  if (!user && !pass) return null;
  const bytes = new TextEncoder().encode(`${user || ''}:${pass || ''}`);
  return `Basic ${toBase64(bytes)}`;
}

// --- Chemins (côté serveur : Windows ou Unix) ---------------------------------

export const isWindowsPath = (p) => /^[a-zA-Z]:/.test(p || '') || (p || '').includes('\\');
export const pathSep = (p) => (isWindowsPath(p) ? '\\' : '/');

export function joinPath(base, name) {
  if (!base) return name;
  const sep = pathSep(base);
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function baseName(p) {
  return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

// Dossier parent, ou null à la racine (lecteur Windows ou « / »).
export function parentPath(p) {
  const t = (p || '').replace(/[\\/]+$/, '');
  if (!t || /^[a-zA-Z]:$/.test(t)) return null;
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (i < 0) return null;
  const parent = t.slice(0, i);
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`;
  return parent || '/';
}

// Nom de dossier valide sous Windows comme sous Linux.
export function safeFolderName(name) {
  return (name || '')
    .replace(/:/g, ' -')
    .replace(/[<>"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}

// États normalisés utilisés par la popup.
export const STATES = [
  'downloading', 'stalled', 'metadata', 'queued', 'checking',
  'seeding', 'completed', 'stopped', 'moving', 'error',
];

export class TorrentClient {
  static meta = {
    id: '',
    label: '',
    description: '',
    placeholder: 'http://192.168.1.20:8080',
    fields: ['username', 'password'],
    rpcPath: '',
    beta: false,
  };

  static caps = {};

  constructor(cfg) {
    this.cfg = cfg;
    this.base = (cfg.serverUrl || '').replace(/\/+$/, '');
  }

  get caps() { return this.constructor.caps; }
  get label() { return this.constructor.meta.label; }
  get webUrl() { return `${this.base}/`; }

  async fetch(url, opts = {}) {
    try {
      return await fetch(url, { credentials: 'include', cache: 'no-store', ...opts });
    } catch {
      throw new ClientError(`Serveur injoignable (${this.base}). Vérifie l'adresse et que l'interface web du client est activée.`, 'NETWORK');
    }
  }

  // Connexion et version : { version, detail }.
  async test() { throw unsupported('Le test de connexion'); }

  // Réglages par défaut du serveur : { savePath, paused, ... }.
  async defaults() { return { savePath: '' }; }

  // { nom: { savePath } }
  async categories() { return {}; }

  async tags() { return []; }

  // Nom du torrent s'il est déjà présent, sinon null.
  async exists() { return null; }

  // [{ name, path, modified? }] — dossiers seulement.
  async listDir() { throw unsupported('La navigation dans les dossiers'); }

  // [{ name, path, type: 'dir' | 'file', size? }] — dossiers et fichiers (analyse de la bibliothèque).
  async listAll() { throw unsupported("L'analyse de la bibliothèque"); }

  // Racines à afficher dans l'explorateur : [{ path, label, free? }].
  async roots() { return []; }

  async freeSpace() { return null; }

  async add() { throw unsupported("L'ajout de torrents"); }

  // { server: { dlSpeed, upSpeed, freeSpace, altSpeed, connection, dlLimit, upLimit, dlSession, upSession },
  //   torrents: [{ hash, name, state, progress, size, dlspeed, upspeed, eta, ratio, addedOn }] }
  async poll() { return { server: {}, torrents: [] }; }

  async start() { throw unsupported('Le démarrage'); }
  async stop() { throw unsupported("L'arrêt"); }
  async toggleAltSpeed() { throw unsupported('Les limites alternatives'); }
}
