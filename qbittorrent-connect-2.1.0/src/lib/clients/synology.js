// Synology Download Station — API Web du NAS (DSM 6 et 7).
import { TorrentClient, ClientError } from './base.js';

const STATE = {
  waiting: 'queued', downloading: 'downloading', paused: 'stopped', finishing: 'checking',
  finished: 'completed', hash_checking: 'checking', seeding: 'seeding', filehosting_waiting: 'queued',
  extracting: 'moving', error: 'error',
};

export class Synology extends TorrentClient {
  static meta = {
    id: 'synology',
    label: 'Synology Download Station',
    description: "Adresse de DSM, par exemple https://mon-nas:5001. Les emplacements commencent par un dossier partagé (video/Séries).",
    placeholder: 'https://192.168.1.20:5001',
    fields: ['username', 'password'],
    rpcPath: '',
    beta: true,
  };

  static caps = { browse: false, startStop: true };

  get webUrl() { return `${this.base}/index.cgi?launchApp=SYNO.SDS.DownloadStation.Application`; }

  async login() {
    const qs = new URLSearchParams({
      api: 'SYNO.API.Auth', version: '3', method: 'login', session: 'DownloadStation', format: 'sid',
      account: this.cfg.username || '', passwd: this.cfg.password || '',
    });
    const res = await this.fetch(`${this.base}/webapi/auth.cgi?${qs}`);
    const json = await res.json().catch(() => ({}));
    if (!json.success) {
      const code = json.error?.code;
      throw new ClientError(code === 400 ? "Nom d'utilisateur ou mot de passe incorrect."
        : code === 403 || code === 404 ? 'La validation en deux étapes doit être désactivée pour ce compte.'
          : `Connexion à DSM impossible (code ${code ?? res.status}).`, 'AUTH');
    }
    this.sid = json.data.sid;
  }

  async api(path, params, { file, filename } = {}, retry = true) {
    if (!this.sid) await this.login();
    let res;
    if (file) {
      // Download Station exige que le fichier soit le dernier champ du formulaire.
      const body = new FormData();
      for (const [k, v] of Object.entries({ ...params, _sid: this.sid })) body.append(k, v);
      body.append('file', file, filename || 'torrent.torrent');
      res = await this.fetch(`${this.base}/webapi/${path}`, { method: 'POST', body });
    } else {
      res = await this.fetch(`${this.base}/webapi/${path}?${new URLSearchParams({ ...params, _sid: this.sid })}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!json.success) {
      // 105/106/107/119 : session expirée ou invalide.
      if (retry && [105, 106, 107, 119].includes(json.error?.code)) {
        this.sid = null;
        return this.api(path, params, { file, filename }, false);
      }
      throw new ClientError(`Download Station : erreur ${json.error?.code ?? res.status}`, 'RPC');
    }
    return json.data || {};
  }

  task(method, params = {}, opts) {
    return this.api('DownloadStation/task.cgi', { api: 'SYNO.DownloadStation.Task', version: '1', method, ...params }, opts);
  }

  async test() {
    const info = await this.api('DownloadStation/info.cgi', { api: 'SYNO.DownloadStation.Info', version: '1', method: 'getinfo' });
    return { version: `Download Station ${info.version_string || ''}`.trim(), detail: '' };
  }

  async defaults() {
    const conf = await this.api('DownloadStation/info.cgi', { api: 'SYNO.DownloadStation.Info', version: '1', method: 'getconfig' }).catch(() => ({}));
    return { savePath: conf.default_destination || '' };
  }

  async add(req) {
    const destination = (req.savePath || '').replace(/^[\\/]+/, '');
    const params = destination ? { destination } : {};
    if (req.torrent) {
      const file = new Blob([req.torrent], { type: 'application/x-bittorrent' });
      await this.task('create', params, { file, filename: req.filename });
    } else {
      await this.task('create', { ...params, uri: req.url });
    }
    return { hash: null };
  }

  async poll() {
    const data = await this.task('list', { additional: 'transfer,detail' });
    const torrents = (data.tasks || []).map((t) => {
      const tr = t.additional?.transfer || {};
      const done = tr.size_downloaded || 0;
      return {
        hash: t.id,
        name: t.title,
        state: STATE[t.status] || 'stopped',
        progress: t.size ? done / t.size : 0,
        size: t.size || 0,
        dlspeed: tr.speed_download || 0,
        upspeed: tr.speed_upload || 0,
        eta: tr.speed_download > 0 ? Math.round((t.size - done) / tr.speed_download) : null,
        ratio: done ? (tr.size_uploaded || 0) / done : null,
        addedOn: t.additional?.detail?.create_time || 0,
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

  start(id) { return this.task('resume', { id }); }
  stop(id) { return this.task('pause', { id }); }
}
