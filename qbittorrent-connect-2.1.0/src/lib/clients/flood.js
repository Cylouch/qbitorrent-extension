// Flood — interface web moderne pour rTorrent, qBittorrent ou Transmission.
import { TorrentClient, ClientError, toBase64, joinPath } from './base.js';

export class Flood extends TorrentClient {
  static meta = {
    id: 'flood',
    label: 'Flood',
    description: 'Interface Flood (jesec/flood), quel que soit le client derrière.',
    placeholder: 'http://192.168.1.20:3000',
    fields: ['username', 'password'],
    rpcPath: '',
    beta: true,
  };

  static caps = { browse: true, library: true, tags: true, sequential: true, startStop: true };

  async login() {
    const res = await this.fetch(`${this.base}/api/auth/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.username || '', password: this.cfg.password || '' }),
    });
    if (res.status === 401) throw new ClientError("Nom d'utilisateur ou mot de passe incorrect.", 'AUTH', 401);
    if (!res.ok) throw new ClientError(`Flood : HTTP ${res.status}`, 'HTTP', res.status);
  }

  async api(path, { method = 'GET', body } = {}, retry = true) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await this.fetch(`${this.base}/api/${path}`, opts);
    if (res.status === 401 && retry) {
      await this.login();
      return this.api(path, { method, body }, false);
    }
    if (!res.ok) throw new ClientError(`Flood : HTTP ${res.status} sur ${path}`, res.status === 404 ? 'NOT_FOUND' : 'HTTP', res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  async test() {
    await this.login();
    await this.api('client/connection-test').catch(() => null);
    return { version: 'Flood', detail: '' };
  }

  async defaults() {
    const s = await this.api('client/settings').catch(() => ({}));
    return { savePath: s.directoryDefault || '' };
  }

  async tags() {
    const { torrents } = await this.poll();
    return [...new Set(torrents.flatMap((t) => t.tags || []))];
  }

  async exists(hash) {
    const r = await this.api('torrents');
    return r.torrents?.[hash.toUpperCase()]?.name ?? null;
  }

  async listDir(path) {
    const r = await this.api(`directory-list?${new URLSearchParams({ path })}`);
    return (r.directories || []).map((name) => ({ name, path: joinPath(r.path || path, name), type: 'dir' }));
  }

  async listAll(path) {
    const r = await this.api(`directory-list?${new URLSearchParams({ path })}`);
    const base = r.path || path;
    return [
      ...(r.directories || []).map((name) => ({ name, path: joinPath(base, name), type: 'dir' })),
      ...(r.files || []).map((name) => ({ name, path: joinPath(base, name), type: 'file' })),
    ];
  }

  async roots() {
    const d = await this.defaults();
    return [{ path: '/', label: 'Racine du serveur', kind: 'drive' }, ...(d.savePath ? [{ path: d.savePath, label: 'Dossier par défaut', kind: 'folder' }] : [])];
  }

  async add(req) {
    const common = {
      destination: req.savePath || undefined,
      tags: req.tags?.length ? req.tags : undefined,
      start: !req.paused,
      isBasePath: false,
      isCompleted: false,
      isSequential: Boolean(req.sequential),
    };
    if (req.torrent) await this.api('torrents/add-files', { method: 'POST', body: { files: [toBase64(req.torrent)], ...common } });
    else await this.api('torrents/add-urls', { method: 'POST', body: { urls: [req.url], ...common } });
    return { hash: req.hash };
  }

  async poll() {
    const r = await this.api('torrents');
    const torrents = Object.values(r.torrents || {}).map((t) => {
      const st = t.status || [];
      let state = 'stopped';
      if (st.includes('error')) state = 'error';
      else if (st.includes('checking')) state = 'checking';
      else if (st.includes('stopped')) state = st.includes('complete') ? 'completed' : 'stopped';
      else if (st.includes('seeding')) state = 'seeding';
      else if (st.includes('downloading')) state = t.downRate > 0 ? 'downloading' : 'stalled';
      return {
        hash: t.hash,
        name: t.name,
        state,
        progress: (t.percentComplete || 0) / 100,
        size: t.sizeBytes || 0,
        dlspeed: t.downRate || 0,
        upspeed: t.upRate || 0,
        eta: t.eta > 0 ? t.eta : null,
        ratio: t.ratio ?? null,
        addedOn: t.dateAdded || 0,
        tags: t.tags || [],
      };
    });
    return {
      server: {
        dlSpeed: torrents.reduce((s, t) => s + t.dlspeed, 0),
        upSpeed: torrents.reduce((s, t) => s + t.upspeed, 0),
        freeSpace: null,
        altSpeed: null,
        connection: 'connected',
      },
      torrents,
    };
  }

  start(hash) { return this.api('torrents/start', { method: 'POST', body: { hashes: [hash] } }); }
  stop(hash) { return this.api('torrents/stop', { method: 'POST', body: { hashes: [hash] } }); }
}
