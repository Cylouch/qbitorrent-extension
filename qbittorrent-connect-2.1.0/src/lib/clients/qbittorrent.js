// qBittorrent — API Web v2 (versions 4.x et 5.x).
import { TorrentClient, ClientError, joinPath, baseName } from './base.js';

const STATE_MAP = {
  downloading: 'downloading', forcedDL: 'downloading',
  metaDL: 'metadata', forcedMetaDL: 'metadata',
  stalledDL: 'stalled',
  queuedDL: 'queued', queuedUP: 'queued',
  checkingDL: 'checking', checkingUP: 'checking', checkingResumeData: 'checking',
  pausedDL: 'stopped', stoppedDL: 'stopped',
  uploading: 'seeding', forcedUP: 'seeding', stalledUP: 'seeding',
  pausedUP: 'completed', stoppedUP: 'completed',
  moving: 'moving',
  missingFiles: 'error', error: 'error',
};

export class QBittorrent extends TorrentClient {
  static meta = {
    id: 'qbittorrent',
    label: 'qBittorrent',
    description: 'Version 4.1 ou plus récente, interface web activée.',
    placeholder: 'http://192.168.1.20:8080',
    fields: ['username', 'password'],
    rpcPath: '',
    beta: false,
  };

  static caps = {
    browse: true, categories: true, categoryPaths: true, tags: true, autoTMM: true,
    downloadPath: true, rename: true, stopCondition: true, topQueue: true, skipChecking: true,
    sequential: true, firstLast: true, contentLayout: true, limits: true, filePriorities: 'full',
    altSpeed: true, startStop: true, freeSpace: true, library: true,
  };

  constructor(cfg) {
    super(cfg);
    this._loginPromise = null;
    this._sync = { rid: 0, torrents: {}, server: {} };
  }

  // Plusieurs appels simultanés peuvent échouer en 403 : un seul login partagé.
  login() {
    this._loginPromise ??= this._doLogin().finally(() => { this._loginPromise = null; });
    return this._loginPromise;
  }

  async _doLogin() {
    const res = await this._call('auth/login', {
      method: 'POST',
      body: new URLSearchParams({ username: this.cfg.username || '', password: this.cfg.password || '' }),
    });
    const text = (await res.text()).trim();
    if (res.status === 403) throw new ClientError("Accès refusé : ton IP est peut-être bannie par qBittorrent après trop d'échecs de connexion.", 'BANNED', 403);
    if (res.status === 401) throw new ClientError("Requête refusée (401). Si l'adresse est correcte, la protection CSRF ou la validation de l'en-tête Host de qBittorrent bloque l'extension.", 'CSRF', 401);
    if (!res.ok) throw new ClientError(`Échec de connexion (HTTP ${res.status}).`, 'HTTP', res.status);
    if (text === 'Fails.') throw new ClientError("Nom d'utilisateur ou mot de passe incorrect.", 'AUTH');
  }

  _call(path, { method = 'GET', params, body } = {}) {
    let url = `${this.base}/api/v2/${path}`;
    if (params) url += `?${new URLSearchParams(params)}`;
    return this.fetch(url, { method, body });
  }

  async request(path, opts = {}) {
    let res = await this._call(path, opts);
    if (res.status === 401 || res.status === 403) {
      await this.login();
      res = await this._call(path, opts);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).trim();
      throw new ClientError(`${path} : HTTP ${res.status}${text ? ` — ${text}` : ''}`, 'HTTP', res.status);
    }
    return res;
  }

  async json(path, params) { return (await this.request(path, { params })).json(); }
  async text(path, params) { return (await (await this.request(path, { params })).text()).trim(); }

  async post(path, data) {
    const body = data instanceof FormData ? data : new URLSearchParams(data);
    return (await (await this.request(path, { method: 'POST', body })).text()).trim();
  }

  async test() {
    await this.login();
    const [version, api] = await Promise.all([this.text('app/version'), this.text('app/webapiVersion').catch(() => '')]);
    return { version: `qBittorrent ${version}`, detail: api ? `API ${api}` : '' };
  }

  async defaults() {
    const p = await this.json('app/preferences');
    return {
      savePath: p.save_path || '',
      autoTMM: Boolean(p.auto_tmm_enabled),
      useDownloadPath: Boolean(p.temp_path_enabled),
      downloadPath: p.temp_path || '',
      // qBittorrent 5 : add_stopped_enabled ; qBittorrent 4 : start_paused_enabled.
      paused: Boolean(p.add_stopped_enabled ?? p.start_paused_enabled ?? false),
      stopCondition: p.torrent_stop_condition || 'None',
      topQueue: Boolean(p.add_to_top_of_queue),
      contentLayout: p.torrent_content_layout || 'Original',
    };
  }

  async categories() {
    const raw = await this.json('torrents/categories');
    return Object.fromEntries(Object.entries(raw || {}).map(([name, c]) => [name, { savePath: c.savePath || '' }]));
  }

  async tags() { return (await this.json('torrents/tags')) || []; }

  async exists(hash) {
    const found = await this.json('torrents/info', { hashes: hash });
    return found[0]?.name ?? null;
  }

  // app/getDirectoryContent existe depuis qBittorrent 5 (non documenté sur le wiki).
  async listDir(path) {
    return (await this._content(path, 'dirs')).filter((e) => e.type !== 'file');
  }

  async listAll(path) {
    return this._content(path, 'all');
  }

  async _content(path, mode) {
    const params = { dirPath: path, mode, withMetadata: 'true' };
    let res = await this._call('app/getDirectoryContent', { params });
    if (res.status === 401 || res.status === 403) {
      await this.login();
      res = await this._call('app/getDirectoryContent', { params });
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).trim();
      if (/does not exist/i.test(text)) throw new ClientError(`Dossier introuvable : ${path}`, 'NOT_FOUND', 404);
      if (res.status === 404) throw new ClientError("Ta version de qBittorrent ne permet pas de parcourir les dossiers (qBittorrent 5 ou plus requis).", 'UNSUPPORTED', 404);
      throw new ClientError(text || `HTTP ${res.status}`, 'HTTP', res.status);
    }
    const entries = await res.json();
    // Sans withMetadata (versions plus anciennes) : chemins seuls, type déduit du mode.
    return entries
      .map((e) => (typeof e === 'string'
        ? { name: baseName(e), path: e, type: mode === 'dirs' ? 'dir' : /\.[a-z0-9]{2,4}$/i.test(e) ? 'file' : 'dir' }
        : { name: e.name, path: joinPath(path, e.name), modified: e.last_modification_date, type: e.type === 'file' ? 'file' : 'dir', size: e.size }))
      .filter((e) => e.name);
  }

  async freeSpace(path) {
    try {
      const v = Number(await this.text('app/getFreeSpaceAtPath', { path }));
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  async roots() {
    const d = await this.defaults();
    if (!/^[a-zA-Z]:/.test(d.savePath)) {
      return [{ path: '/', label: 'Racine du serveur', kind: 'drive', free: await this.freeSpace('/') }];
    }
    // Serveur Windows : on sonde chaque lettre de lecteur.
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    const probe = await Promise.all(letters.map(async (l) => {
      const res = await this._call('app/getDirectoryContent', { params: { dirPath: `${l}:/`, mode: 'dirs' } }).catch(() => null);
      return res?.ok ? l : null;
    }));
    const drives = probe.filter(Boolean);
    return Promise.all(drives.map(async (l) => ({
      path: `${l}:\\`,
      label: `Disque (${l}:)`,
      kind: 'drive',
      free: await this.freeSpace(`${l}:/`),
    })));
  }

  async add(req) {
    if (req.category) {
      const cats = await this.categories().catch(() => ({}));
      if (!cats[req.category]) await this.post('torrents/createCategory', { category: req.category, savePath: '' });
    }
    if (req.newTags?.length) await this.post('torrents/createTags', { tags: req.newTags.join(',') });

    const customPrio = Array.isArray(req.filePriorities) && req.filePriorities.some((p) => p !== 1);
    const form = new FormData();
    if (req.torrent) form.append('torrents', new Blob([req.torrent], { type: 'application/x-bittorrent' }), req.filename || 'torrent.torrent');
    else form.append('urls', req.url);
    if (req.autoTMM != null) form.append('autoTMM', String(Boolean(req.autoTMM)));
    if (!req.autoTMM) {
      if (req.savePath) form.append('savepath', req.savePath);
      if (req.useDownloadPath != null) {
        form.append('useDownloadPath', String(Boolean(req.useDownloadPath && req.downloadPath)));
        if (req.useDownloadPath && req.downloadPath) form.append('downloadPath', req.downloadPath);
      }
    }
    if (req.category) form.append('category', req.category);
    if (req.tags?.length) form.append('tags', req.tags.join(','));
    if (req.rename) form.append('rename', req.rename);

    // Si des fichiers sont désélectionnés, on ajoute le torrent arrêté le temps
    // d'appliquer les priorités, pour ne rien télécharger de non voulu.
    const stopped = Boolean(req.paused) || customPrio;
    form.append('stopped', String(stopped)); // qBittorrent 5
    form.append('paused', String(stopped)); // qBittorrent 4
    if (req.stopCondition) form.append('stopCondition', req.stopCondition);
    if (req.topQueue != null) form.append('addToTopOfQueue', String(Boolean(req.topQueue)));
    if (req.skipChecking) form.append('skip_checking', 'true');
    if (req.sequential) form.append('sequentialDownload', 'true');
    if (req.firstLast) form.append('firstLastPiecePrio', 'true');
    if (req.contentLayout) form.append('contentLayout', req.contentLayout);
    if (req.dlLimit > 0) form.append('dlLimit', String(Math.round(req.dlLimit)));
    if (req.upLimit > 0) form.append('upLimit', String(Math.round(req.upLimit)));

    const text = await this.post('torrents/add', form);
    if (text === 'Fails.') throw new ClientError('qBittorrent a refusé le torrent (déjà présent ou fichier invalide).', 'REJECTED');

    if (customPrio && req.hash) {
      await this._waitForFiles(req.hash, req.filePriorities.length);
      const groups = new Map();
      req.filePriorities.forEach((p, i) => {
        if (p === 1) return;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(i);
      });
      for (const [priority, ids] of groups) {
        await this.post('torrents/filePrio', { hash: req.hash, id: ids.join('|'), priority });
      }
      if (!req.paused) await this.start(req.hash);
    }
    return { hash: req.hash };
  }

  async _waitForFiles(hash, count) {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const files = await this.json('torrents/files', { hash });
        if (files.length >= count) return;
      } catch (e) {
        if (e.status !== 404 && e.status !== 409) throw e;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new ClientError("le torrent n'est pas apparu dans qBittorrent à temps pour appliquer les priorités", 'TIMEOUT');
  }

  // Données incrémentales : seuls les changements depuis `rid` sont renvoyés.
  async poll() {
    const s = this._sync;
    let r;
    try {
      r = await this.json('sync/maindata', { rid: s.rid });
    } catch (e) {
      s.rid = 0;
      throw e;
    }
    if (r.full_update) {
      s.torrents = {};
      s.server = {};
    }
    s.rid = r.rid;
    for (const [hash, t] of Object.entries(r.torrents || {})) s.torrents[hash] = { ...(s.torrents[hash] || {}), ...t };
    for (const hash of r.torrents_removed || []) delete s.torrents[hash];
    Object.assign(s.server, r.server_state || {});

    const sv = s.server;
    return {
      server: {
        dlSpeed: sv.dl_info_speed || 0,
        upSpeed: sv.up_info_speed || 0,
        dlSession: sv.dl_info_data || 0,
        upSession: sv.up_info_data || 0,
        dlLimit: sv.dl_rate_limit || 0,
        upLimit: sv.up_rate_limit || 0,
        freeSpace: sv.free_space_on_disk ?? null,
        altSpeed: sv.use_alt_speed_limits ?? null,
        connection: sv.connection_status || 'connected',
      },
      torrents: Object.entries(s.torrents).map(([hash, t]) => ({
        hash,
        name: t.name,
        state: STATE_MAP[t.state] || 'stopped',
        progress: t.progress || 0,
        size: t.size || 0,
        dlspeed: t.dlspeed || 0,
        upspeed: t.upspeed || 0,
        eta: t.eta > 0 && t.eta < 8640000 ? t.eta : null,
        ratio: t.ratio ?? null,
        addedOn: t.added_on || 0,
      })),
    };
  }

  // qBittorrent 5 : torrents/start|stop ; qBittorrent 4 : torrents/resume|pause.
  async start(hash) {
    try { await this.post('torrents/start', { hashes: hash }); } catch (e) {
      if (e.status !== 404) throw e;
      await this.post('torrents/resume', { hashes: hash });
    }
  }

  async stop(hash) {
    try { await this.post('torrents/stop', { hashes: hash }); } catch (e) {
      if (e.status !== 404) throw e;
      await this.post('torrents/pause', { hashes: hash });
    }
  }

  async toggleAltSpeed() { await this.post('transfer/toggleSpeedLimitsMode', {}); }
}
