// Deluge — API JSON de l'interface web (Deluge 1.3 et 2.x).
import { TorrentClient, ClientError, toBase64 } from './base.js';

const FIELDS = ['name', 'state', 'progress', 'total_size', 'download_payload_rate', 'upload_payload_rate',
  'eta', 'ratio', 'time_added', 'label'];

// Priorités qBittorrent (0, 1, 6, 7) vers Deluge (0 ignoré, 4 normal, 7 maximale).
const PRIO = { 0: 0, 1: 4, 6: 6, 7: 7 };

export class Deluge extends TorrentClient {
  static meta = {
    id: 'deluge',
    label: 'Deluge',
    description: 'Deluge 1.3 ou 2.x, interface web (deluge-web) activée.',
    placeholder: 'http://192.168.1.20:8112',
    fields: ['password'],
    rpcPath: '',
    beta: false,
  };

  static caps = {
    browse: false, categories: true, categoryPaths: false, limits: true, sequential: true,
    filePriorities: 'full', startStop: true, freeSpace: true,
  };

  _id = 0;

  async call(method, params = []) {
    const res = await this.fetch(`${this.base}/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params, id: ++this._id }),
    });
    if (!res.ok) throw new ClientError(`Deluge : HTTP ${res.status}`, 'HTTP', res.status);
    const json = await res.json();
    if (json.error) {
      const msg = json.error.message || 'erreur inconnue';
      throw new ClientError(`Deluge : ${msg}`, json.error.code === 1 ? 'AUTH' : /unknown method/i.test(msg) ? 'NO_METHOD' : 'RPC');
    }
    return json.result;
  }

  async ensure() {
    if (this._ready) return;
    const valid = await this.call('auth.check_session').catch(() => false);
    if (!valid) {
      const ok = await this.call('auth.login', [this.cfg.password || '']);
      if (!ok) throw new ClientError('Mot de passe Deluge incorrect.', 'AUTH');
    }
    // L'interface web doit être reliée à un démon Deluge.
    if (!(await this.call('web.connected'))) {
      const hosts = await this.call('web.get_hosts');
      if (!hosts?.length) throw new ClientError("Aucun démon Deluge n'est configuré dans l'interface web.", 'NO_DAEMON');
      await this.call('web.connect', [hosts[0][0]]);
    }
    this._ready = true;
  }

  async rpc(method, params) {
    await this.ensure();
    try {
      return await this.call(method, params);
    } catch (e) {
      if (e.code !== 'AUTH') throw e;
      this._ready = false;
      await this.ensure();
      return this.call(method, params);
    }
  }

  async test() {
    // Le test valide toujours le mot de passe, même si une session est déjà ouverte.
    const ok = await this.call('auth.login', [this.cfg.password || '']);
    if (!ok) throw new ClientError('Mot de passe Deluge incorrect.', 'AUTH');
    this._ready = false;
    await this.ensure();
    const version = await this.call('daemon.info').catch(() => '');
    return { version: `Deluge ${version || ''}`.trim(), detail: '' };
  }

  async defaults() {
    const [savePath, paused] = await Promise.all([
      this.rpc('core.get_config_value', ['download_location']),
      this.rpc('core.get_config_value', ['add_paused']).catch(() => false),
    ]);
    return { savePath: savePath || '', paused: Boolean(paused) };
  }

  // Les « catégories » sont les étiquettes du plugin Label.
  async categories() {
    try {
      const labels = await this.rpc('label.get_labels');
      return Object.fromEntries((labels || []).map((l) => [l, { savePath: '' }]));
    } catch {
      return {};
    }
  }

  async exists(hash) {
    const r = await this.rpc('core.get_torrent_status', [hash, ['name']]);
    return r?.name ?? null;
  }

  async freeSpace(path) {
    try { return await this.rpc('core.get_free_space', [path]); } catch { return null; }
  }

  async add(req) {
    const options = { add_paused: Boolean(req.paused) };
    if (req.savePath) options.download_location = req.savePath;
    if (req.dlLimit > 0) options.max_download_speed = req.dlLimit / 1024;
    if (req.upLimit > 0) options.max_upload_speed = req.upLimit / 1024;
    if (req.sequential) options.sequential_download = true;
    if (Array.isArray(req.filePriorities)) options.file_priorities = req.filePriorities.map((p) => PRIO[p] ?? 4);

    let id;
    if (req.torrent) id = await this.rpc('core.add_torrent_file', [req.filename || 'torrent.torrent', toBase64(req.torrent), options]);
    else if (/^magnet:/i.test(req.url)) id = await this.rpc('core.add_torrent_magnet', [req.url, options]);
    else id = await this.rpc('core.add_torrent_url', [req.url, options]);
    if (!id && req.hash && (await this.exists(req.hash).catch(() => null))) {
      throw new ClientError('Ce torrent est déjà présent dans Deluge.', 'DUPLICATE');
    }
    id = id || req.hash;

    if (req.category && id) {
      // Les étiquettes Deluge sont en minuscules.
      const label = req.category.toLowerCase();
      const existing = await this.rpc('label.get_labels').catch(() => null);
      if (existing && !existing.includes(label)) await this.rpc('label.add', [label]).catch(() => {});
      await this.rpc('label.set_torrent', [id, label]).catch(() => {});
    }
    return { hash: id };
  }

  async poll() {
    const r = await this.rpc('web.update_ui', [FIELDS, {}]);
    const stats = r.stats || {};
    return {
      server: {
        dlSpeed: stats.download_rate || 0,
        upSpeed: stats.upload_rate || 0,
        freeSpace: stats.free_space ?? null,
        altSpeed: null,
        connection: r.connected === false ? 'disconnected' : 'connected',
      },
      torrents: Object.entries(r.torrents || {}).map(([hash, t]) => ({
        hash,
        name: t.name,
        state: this._state(t),
        progress: (t.progress || 0) / 100,
        size: t.total_size || 0,
        dlspeed: t.download_payload_rate || 0,
        upspeed: t.upload_payload_rate || 0,
        eta: t.eta > 0 ? t.eta : null,
        ratio: t.ratio >= 0 ? t.ratio : null,
        addedOn: Math.round(t.time_added || 0),
      })),
    };
  }

  _state(t) {
    switch (t.state) {
      case 'Downloading': return t.download_payload_rate > 0 ? 'downloading' : 'stalled';
      case 'Seeding': return 'seeding';
      case 'Paused': return t.progress >= 100 ? 'completed' : 'stopped';
      case 'Checking': case 'Allocating': return 'checking';
      case 'Queued': return 'queued';
      case 'Moving': return 'moving';
      case 'Error': return 'error';
      default: return 'stopped';
    }
  }

  // Deluge 2 : resume_torrents / pause_torrents ; Deluge 1.3 : resume_torrent / pause_torrent.
  async _each(plural, singular, hash) {
    try {
      await this.rpc(plural, [[hash]]);
    } catch (e) {
      if (e.code !== 'NO_METHOD') throw e;
      await this.rpc(singular, [[hash]]);
    }
  }

  start(hash) { return this._each('core.resume_torrents', 'core.resume_torrent', hash); }
  stop(hash) { return this._each('core.pause_torrents', 'core.pause_torrent', hash); }
}
