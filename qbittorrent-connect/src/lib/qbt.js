// Client minimal pour l'API Web de qBittorrent (v2), compatible 4.x et 5.x.
import { normalizePath, joinPath, baseName } from './paths.js';

export class QbtError extends Error {
  constructor(message, code, status, detail = '') {
    super(message);
    this.name = 'QbtError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// Méthode d'API inconnue (version trop ancienne) : 404 avec le texte de statut
// seul. Les autres 404 portent un message, éventuellement traduit.
const isUnknownMethod = (e) => e.status === 404 && /^(not found)?$/i.test(e.detail || '');

export class Qbt {
  constructor({ serverUrl, username, password }) {
    this.base = serverUrl.replace(/\/+$/, '');
    this.username = username || '';
    this.password = password || '';
    this._loginPromise = null;
  }

  // Plusieurs appels simultanés peuvent échouer en 403 : un seul login partagé.
  login() {
    this._loginPromise ??= this._doLogin().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  async _doLogin() {
    const res = await this._fetch('auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username: this.username, password: this.password }),
    });
    const text = (await res.text()).trim();
    if (res.status === 403) {
      throw new QbtError("Accès refusé : ton IP est peut-être bannie par qBittorrent après trop d'échecs de connexion.", 'BANNED', 403);
    }
    if (res.status === 401) {
      throw new QbtError("Requête refusée (401). Si l'adresse est correcte, la protection CSRF ou la validation de l'en-tête Host de qBittorrent bloque l'extension.", 'CSRF', 401);
    }
    if (!res.ok) throw new QbtError(`Échec de connexion (HTTP ${res.status}).`, 'HTTP', res.status);
    if (text === 'Fails.') throw new QbtError("Nom d'utilisateur ou mot de passe incorrect.", 'AUTH');
  }

  async _fetch(path, { method = 'GET', params, body } = {}) {
    let url = `${this.base}/api/v2/${path}`;
    if (params) url += `?${new URLSearchParams(params)}`;
    try {
      return await fetch(url, { method, body, credentials: 'include', cache: 'no-store' });
    } catch {
      throw new QbtError(`Serveur injoignable (${this.base}). Vérifie l'adresse et que l'interface web est activée.`, 'NETWORK');
    }
  }

  async request(path, opts = {}) {
    let res = await this._fetch(path, opts);
    if (res.status === 401 || res.status === 403) {
      await this.login();
      res = await this._fetch(path, opts);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).trim();
      throw new QbtError(`${path} : HTTP ${res.status}${text ? ` — ${text}` : ''}`, 'HTTP', res.status, text);
    }
    return res;
  }

  async json(path, params) {
    return (await this.request(path, { params })).json();
  }

  async text(path, params) {
    return (await (await this.request(path, { params })).text()).trim();
  }

  async post(path, data) {
    const body = data instanceof FormData ? data : new URLSearchParams(data);
    return (await (await this.request(path, { method: 'POST', body })).text()).trim();
  }

  version() { return this.text('app/version'); }
  apiVersion() { return this.text('app/webapiVersion'); }
  preferences() { return this.json('app/preferences'); }
  categories() { return this.json('torrents/categories'); }
  tags() { return this.json('torrents/tags'); }
  transferInfo() { return this.json('transfer/info'); }
  torrents(params) { return this.json('torrents/info', params); }
  files(hash) { return this.json('torrents/files', { hash }); }

  createCategory(category, savePath = '') {
    return this.post('torrents/createCategory', { category, savePath });
  }

  createTags(tags) {
    return this.post('torrents/createTags', { tags: tags.join(',') });
  }

  async addTorrent(form) {
    const text = await this.post('torrents/add', form);
    if (text === 'Fails.') {
      throw new QbtError('qBittorrent a refusé le torrent (déjà présent ou fichier invalide).', 'REJECTED');
    }
    return text;
  }

  filePrio(hash, ids, priority) {
    return this.post('torrents/filePrio', { hash, id: ids.join('|'), priority });
  }

  // qBittorrent 5 : torrents/start ; qBittorrent 4 : torrents/resume.
  async start(hashes) {
    try {
      await this.post('torrents/start', { hashes });
    } catch (e) {
      if (e.status !== 404) throw e;
      await this.post('torrents/resume', { hashes });
    }
  }

  // qBittorrent 5 : torrents/stop ; qBittorrent 4 : torrents/pause.
  async stop(hashes) {
    try {
      await this.post('torrents/stop', { hashes });
    } catch (e) {
      if (e.status !== 404) throw e;
      await this.post('torrents/pause', { hashes });
    }
  }

  // Données incrémentales : seuls les changements depuis `rid` sont renvoyés.
  maindata(rid = 0) {
    return this.json('sync/maindata', { rid });
  }

  toggleAltSpeed() {
    return this.post('transfer/toggleSpeedLimitsMode', {});
  }

  // --- Dossiers et disques du serveur ---------------------------------------

  // Contenu d'un dossier : [{ name, path, type: 'dir' | 'file', size, modified }].
  // qBittorrent 5.0+ ; tailles et dates à partir de 5.2.
  async dirContent(path, mode = 'all') {
    const base = normalizePath(path);
    const raw = await this._dir(base, { mode, withMetadata: 'true' });
    if (raw.some((e) => typeof e === 'string')) {
      // qBittorrent 5.0 et 5.1 : chemins seuls. Une 2e requête distingue les dossiers.
      const dirs = mode === 'all' ? new Set((await this._dir(base, { mode: 'dirs' })).map(baseName)) : null;
      return raw.map((p) => {
        const name = baseName(p);
        const isDir = dirs ? dirs.has(name) : mode === 'dirs';
        return { name, path: joinPath(base, name), type: isDir ? 'dir' : 'file', size: null, modified: null };
      });
    }
    return raw.map((e) => ({
      name: e.name,
      path: joinPath(base, e.name),
      type: e.type === 'file' ? 'file' : 'dir',
      size: e.size ?? null,
      modified: e.last_modification_date ?? null,
    }));
  }

  async dirExists(path) {
    try {
      await this._dir(normalizePath(path), { mode: 'dirs' });
      return true;
    } catch (e) {
      if (e.code === 'NOT_FOUND' || e.code === 'BAD_PATH') return false;
      throw e;
    }
  }

  async _dir(path, params) {
    try {
      return await this.json('app/getDirectoryContent', { dirPath: path, ...params });
    } catch (e) {
      if (isUnknownMethod(e)) {
        this.noBrowse = true;
        throw new QbtError('Parcourir les dossiers du serveur demande qBittorrent 5.0 ou plus récent.', 'UNSUPPORTED', 404);
      }
      if (e.status === 404) throw new QbtError(`Dossier introuvable : ${path}`, 'NOT_FOUND', 404);
      if (e.status === 400) throw new QbtError(`Chemin invalide : ${path}`, 'BAD_PATH', 400);
      throw e;
    }
  }

  // Espace libre sur le disque qui contient `path` (qBittorrent 5.3+), ou null.
  async freeSpaceAt(path) {
    if (this.noFreeSpace) return null;
    try {
      const v = Number(await this.text('app/getFreeSpaceAtPath', { path: normalizePath(path) }));
      return Number.isFinite(v) && v >= 0 ? v : null;
    } catch (e) {
      if (isUnknownMethod(e)) this.noFreeSpace = true;
      return null;
    }
  }
}
