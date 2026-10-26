// Transmission — RPC JSON (aussi utilisé par Vuze / BiglyBT avec le plugin Web Remote).
import { TorrentClient, ClientError, basicAuth, toBase64 } from './base.js';

const FIELDS = ['hashString', 'name', 'status', 'percentDone', 'rateDownload', 'rateUpload', 'totalSize',
  'eta', 'uploadRatio', 'addedDate', 'error', 'metadataPercentComplete'];

export class Transmission extends TorrentClient {
  static meta = {
    id: 'transmission',
    label: 'Transmission',
    description: 'Transmission 2.x à 4.x, Vuze / BiglyBT (plugin Web Remote).',
    placeholder: 'http://192.168.1.20:9091',
    fields: ['username', 'password', 'rpcPath'],
    rpcPath: '/transmission/rpc',
    beta: false,
  };

  static caps = {
    browse: false, categories: false, tags: true, rename: true, limits: true, sequential: true,
    filePriorities: 'full', altSpeed: true, startStop: true, freeSpace: true,
  };

  get endpoint() { return this.base + (this.cfg.rpcPath || Transmission.meta.rpcPath); }
  get webUrl() { return `${this.base}/transmission/web/`; }

  async rpc(method, args = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const auth = basicAuth(this.cfg.username, this.cfg.password);
    if (auth) headers.Authorization = auth;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.sessionId) headers['X-Transmission-Session-Id'] = this.sessionId;
      const res = await this.fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify({ method, arguments: args }) });
      // Transmission renvoie 409 avec un jeton de session à rejouer.
      if (res.status === 409) {
        this.sessionId = res.headers.get('X-Transmission-Session-Id');
        continue;
      }
      if (res.status === 401) throw new ClientError("Nom d'utilisateur ou mot de passe incorrect.", 'AUTH', 401);
      if (res.status === 403) throw new ClientError("Accès refusé par Transmission : ajoute l'adresse IP de ce PC dans « rpc-whitelist » (settings.json).", 'FORBIDDEN', 403);
      if (res.status === 421) throw new ClientError("Transmission refuse ce nom d'hôte : ajoute-le dans « rpc-host-whitelist » (settings.json).", 'FORBIDDEN', 421);
      if (!res.ok) throw new ClientError(`Transmission : HTTP ${res.status}`, 'HTTP', res.status);
      const json = await res.json();
      if (json.result !== 'success') throw new ClientError(`Transmission : ${json.result}`, 'RPC');
      return json.arguments || {};
    }
    throw new ClientError('Transmission a refusé le jeton de session.', 'RPC');
  }

  async test() {
    const s = await this.rpc('session-get', { fields: ['version', 'rpc-version'] });
    return { version: `Transmission ${s.version || ''}`.trim(), detail: s['rpc-version'] ? `RPC ${s['rpc-version']}` : '' };
  }

  async defaults() {
    const s = await this.rpc('session-get');
    return {
      savePath: s['download-dir'] || '',
      paused: s['start-added-torrents'] === false,
      useDownloadPath: Boolean(s['incomplete-dir-enabled']),
      downloadPath: s['incomplete-dir'] || '',
    };
  }

  async exists(hash) {
    const r = await this.rpc('torrent-get', { ids: [hash], fields: ['name'] });
    return r.torrents?.[0]?.name ?? null;
  }

  async freeSpace(path) {
    try {
      const r = await this.rpc('free-space', { path });
      return r['size-bytes'] ?? null;
    } catch {
      return null;
    }
  }

  async add(req) {
    const args = { paused: Boolean(req.paused) };
    if (req.torrent) args.metainfo = toBase64(req.torrent);
    else args.filename = req.url;
    if (req.savePath) args['download-dir'] = req.savePath;
    if (req.tags?.length) args.labels = req.tags;
    if (req.sequential) args.sequential_download = true;
    if (Array.isArray(req.filePriorities)) {
      const idx = (test) => req.filePriorities.map((p, i) => (test(p) ? i : -1)).filter((i) => i >= 0);
      const unwanted = idx((p) => p === 0);
      const high = idx((p) => p >= 6);
      if (unwanted.length) args['files-unwanted'] = unwanted;
      if (high.length) args['priority-high'] = high;
    }
    const r = await this.rpc('torrent-add', args);
    if (r['torrent-duplicate']) throw new ClientError('Ce torrent est déjà présent dans Transmission.', 'DUPLICATE');
    const t = r['torrent-added'];
    const hash = t?.hashString || req.hash;
    if (t && req.rename && req.rename !== t.name) {
      await this.rpc('torrent-rename-path', { ids: [hash], path: t.name, name: req.rename }).catch(() => {});
    }
    if (req.dlLimit > 0 || req.upLimit > 0) {
      const set = { ids: [hash] };
      if (req.dlLimit > 0) Object.assign(set, { downloadLimit: Math.round(req.dlLimit / 1024), downloadLimited: true });
      if (req.upLimit > 0) Object.assign(set, { uploadLimit: Math.round(req.upLimit / 1024), uploadLimited: true });
      await this.rpc('torrent-set', set).catch(() => {});
    }
    return { hash };
  }

  async poll() {
    const [list, stats, session] = await Promise.all([
      this.rpc('torrent-get', { fields: FIELDS }),
      this.rpc('session-stats'),
      this.rpc('session-get', { fields: ['alt-speed-enabled', 'download-dir', 'speed-limit-down', 'speed-limit-down-enabled', 'speed-limit-up', 'speed-limit-up-enabled'] }),
    ]);
    const free = session['download-dir'] ? await this.freeSpace(session['download-dir']) : null;
    const current = stats['current-stats'] || {};
    return {
      server: {
        dlSpeed: stats.downloadSpeed || 0,
        upSpeed: stats.uploadSpeed || 0,
        dlSession: current.downloadedBytes || 0,
        upSession: current.uploadedBytes || 0,
        dlLimit: session['speed-limit-down-enabled'] ? session['speed-limit-down'] * 1024 : 0,
        upLimit: session['speed-limit-up-enabled'] ? session['speed-limit-up'] * 1024 : 0,
        freeSpace: free,
        altSpeed: session['alt-speed-enabled'] ?? null,
        connection: 'connected',
      },
      torrents: (list.torrents || []).map((t) => ({
        hash: t.hashString,
        name: t.name,
        state: this._state(t),
        progress: t.percentDone || 0,
        size: t.totalSize || 0,
        dlspeed: t.rateDownload || 0,
        upspeed: t.rateUpload || 0,
        eta: t.eta > 0 ? t.eta : null,
        ratio: t.uploadRatio >= 0 ? t.uploadRatio : null,
        addedOn: t.addedDate || 0,
      })),
    };
  }

  // 0 arrêté, 1-2 vérification, 3 en file, 4 téléchargement, 5 en file (partage), 6 partage.
  _state(t) {
    if (t.error) return 'error';
    switch (t.status) {
      case 0: return t.percentDone >= 1 ? 'completed' : 'stopped';
      case 1: case 2: return 'checking';
      case 3: case 5: return 'queued';
      case 4:
        if (t.metadataPercentComplete < 1) return 'metadata';
        return t.rateDownload > 0 ? 'downloading' : 'stalled';
      case 6: return 'seeding';
      default: return 'stopped';
    }
  }

  async start(hash) { await this.rpc('torrent-start', { ids: [hash] }); }
  async stop(hash) { await this.rpc('torrent-stop', { ids: [hash] }); }

  async toggleAltSpeed() {
    const s = await this.rpc('session-get', { fields: ['alt-speed-enabled'] });
    await this.rpc('session-set', { 'alt-speed-enabled': !s['alt-speed-enabled'] });
  }
}
