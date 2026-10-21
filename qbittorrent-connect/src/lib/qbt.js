// Client minimal pour l'API Web de qBittorrent (v2), compatible 4.x et 5.x.

export class QbtError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'QbtError';
    this.code = code;
    this.status = status;
  }
}

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
      throw new QbtError(`${path} : HTTP ${res.status}${text ? ` — ${text}` : ''}`, 'HTTP', res.status);
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
}
