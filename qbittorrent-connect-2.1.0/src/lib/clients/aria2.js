// aria2 — RPC JSON (aria2c --enable-rpc).
import { TorrentClient, ClientError, toBase64, baseName } from './base.js';

const KEYS = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'uploadSpeed',
  'uploadLength', 'infoHash', 'bittorrent', 'files', 'errorCode'];

export class Aria2 extends TorrentClient {
  static meta = {
    id: 'aria2',
    label: 'aria2',
    description: 'aria2c lancé avec --enable-rpc. Le jeton correspond à --rpc-secret.',
    placeholder: 'http://192.168.1.20:6800',
    fields: ['token', 'rpcPath'],
    rpcPath: '/jsonrpc',
    beta: true,
  };

  static caps = { browse: false, limits: true, filePriorities: 'select', startStop: true };

  get endpoint() { return this.base + (this.cfg.rpcPath || Aria2.meta.rpcPath); }

  _id = 0;

  async call(method, ...params) {
    const all = this.cfg.token ? [`token:${this.cfg.token}`, ...params] : params;
    const res = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: String(++this._id), method, params: all }),
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new ClientError(`aria2 : HTTP ${res.status}`, 'HTTP', res.status);
    if (json.error) {
      throw new ClientError(/unauthorized/i.test(json.error.message) ? 'Jeton secret aria2 incorrect.' : `aria2 : ${json.error.message}`,
        /unauthorized/i.test(json.error.message) ? 'AUTH' : 'RPC');
    }
    return json.result;
  }

  async test() {
    const v = await this.call('aria2.getVersion');
    return { version: `aria2 ${v.version}`, detail: '' };
  }

  async defaults() {
    const o = await this.call('aria2.getGlobalOption').catch(() => ({}));
    return { savePath: o.dir || '', paused: o.pause === 'true' };
  }

  async exists(hash) {
    const { torrents } = await this.poll();
    return torrents.find((t) => t.infoHash?.toLowerCase() === hash.toLowerCase())?.name ?? null;
  }

  async add(req) {
    const opts = { pause: String(Boolean(req.paused)) };
    if (req.savePath) opts.dir = req.savePath;
    if (req.dlLimit > 0) opts['max-download-limit'] = `${Math.round(req.dlLimit / 1024)}K`;
    if (req.upLimit > 0) opts['max-upload-limit'] = `${Math.round(req.upLimit / 1024)}K`;
    if (Array.isArray(req.filePriorities) && req.filePriorities.some((p) => p === 0)) {
      opts['select-file'] = req.filePriorities.map((p, i) => (p > 0 ? i + 1 : 0)).filter(Boolean).join(',');
    }
    if (req.torrent) await this.call('aria2.addTorrent', toBase64(req.torrent), [], opts);
    else await this.call('aria2.addUri', [req.url], opts);
    return { hash: req.hash };
  }

  async poll() {
    const [active, waiting, stopped, stat] = await Promise.all([
      this.call('aria2.tellActive', KEYS),
      this.call('aria2.tellWaiting', 0, 200, KEYS),
      this.call('aria2.tellStopped', 0, 200, KEYS),
      this.call('aria2.getGlobalStat'),
    ]);
    const torrents = [...active, ...waiting, ...stopped].filter((t) => t.bittorrent).map((t) => {
      const total = Number(t.totalLength) || 0;
      const done = Number(t.completedLength) || 0;
      const dl = Number(t.downloadSpeed) || 0;
      const complete = total > 0 && done >= total;
      const state = {
        active: complete ? 'seeding' : dl > 0 ? 'downloading' : 'stalled',
        waiting: 'queued',
        paused: complete ? 'completed' : 'stopped',
        error: 'error',
        complete: 'completed',
        removed: 'stopped',
      }[t.status] || 'stopped';
      return {
        hash: t.gid,
        infoHash: t.infoHash,
        name: t.bittorrent?.info?.name || baseName(t.files?.[0]?.path) || t.gid,
        state,
        progress: total ? done / total : 0,
        size: total,
        dlspeed: dl,
        upspeed: Number(t.uploadSpeed) || 0,
        eta: dl > 0 ? Math.round((total - done) / dl) : null,
        ratio: done ? (Number(t.uploadLength) || 0) / done : null,
        addedOn: 0,
      };
    });
    return {
      server: {
        dlSpeed: Number(stat.downloadSpeed) || 0,
        upSpeed: Number(stat.uploadSpeed) || 0,
        freeSpace: null,
        altSpeed: null,
        connection: 'connected',
      },
      torrents,
    };
  }

  start(gid) { return this.call('aria2.unpause', gid); }
  stop(gid) { return this.call('aria2.pause', gid); }
}
