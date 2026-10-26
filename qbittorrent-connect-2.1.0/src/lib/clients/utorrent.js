// µTorrent / BitTorrent — interface web (/gui).
import { TorrentClient, ClientError, basicAuth } from './base.js';

export class UTorrent extends TorrentClient {
  static meta = {
    id: 'utorrent',
    label: 'µTorrent / BitTorrent',
    description: 'Client Windows avec « Interface web » activée dans les préférences.',
    placeholder: 'http://192.168.1.20:8080',
    fields: ['username', 'password'],
    rpcPath: '',
    beta: true,
  };

  static caps = { browse: false, categories: true, categoryPaths: false, startStop: true };

  get webUrl() { return `${this.base}/gui/`; }

  get headers() {
    const auth = basicAuth(this.cfg.username, this.cfg.password);
    return auth ? { Authorization: auth } : {};
  }

  async token(force = false) {
    if (this._token && !force) return this._token;
    const res = await this.fetch(`${this.base}/gui/token.html`, { headers: this.headers });
    if (res.status === 401) throw new ClientError("Nom d'utilisateur ou mot de passe incorrect.", 'AUTH', 401);
    if (!res.ok) throw new ClientError(`µTorrent : HTTP ${res.status}`, 'HTTP', res.status);
    const m = /<div[^>]*id=["']token["'][^>]*>([^<]+)</i.exec(await res.text());
    if (!m) throw new ClientError("Jeton de l'interface web µTorrent introuvable.", 'AUTH');
    this._token = m[1];
    return this._token;
  }

  async api(params, opts = {}, retry = true) {
    const qs = new URLSearchParams({ token: await this.token(), ...params });
    const res = await this.fetch(`${this.base}/gui/?${qs}`, { headers: this.headers, ...opts });
    // Jeton expiré : µTorrent répond 400.
    if ((res.status === 400 || res.status === 401) && retry) {
      await this.token(true);
      return this.api(params, opts, false);
    }
    if (!res.ok) throw new ClientError(`µTorrent : HTTP ${res.status}`, 'HTTP', res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return {}; }
  }

  async test() {
    const r = await this.api({ list: 1 });
    return { version: `µTorrent${r.build ? ` (build ${r.build})` : ''}`, detail: '' };
  }

  async _dirs() {
    const r = await this.api({ action: 'list-dirs' });
    return r['download-dirs'] || [];
  }

  async defaults() {
    const dirs = await this._dirs().catch(() => []);
    return { savePath: dirs[0]?.path || '' };
  }

  async categories() {
    const r = await this.api({ list: 1 });
    return Object.fromEntries((r.label || []).map(([name]) => [name, { savePath: '' }]));
  }

  async exists(hash) {
    const r = await this.api({ list: 1 });
    return (r.torrents || []).find((t) => t[0].toUpperCase() === hash.toUpperCase())?.[2] ?? null;
  }

  async freeSpace(path) {
    const dirs = await this._dirs().catch(() => []);
    const d = dirs.find((x) => path?.toLowerCase().startsWith(x.path.toLowerCase())) || dirs[0];
    return d?.available != null ? d.available * 1024 * 1024 : null;
  }

  // µTorrent n'accepte que ses dossiers de téléchargement prédéfinis, plus un sous-chemin.
  async _target(savePath) {
    if (!savePath) return {};
    const dirs = await this._dirs().catch(() => []);
    const idx = dirs.findIndex((d) => savePath.toLowerCase().startsWith(d.path.toLowerCase()));
    if (idx < 0) return { download_dir: 0 };
    const rel = savePath.slice(dirs[idx].path.length).replace(/^[\\/]+/, '');
    return rel ? { download_dir: idx, path: rel } : { download_dir: idx };
  }

  async add(req) {
    const target = await this._target(req.savePath);
    if (req.torrent) {
      const form = new FormData();
      form.append('torrent_file', new Blob([req.torrent], { type: 'application/x-bittorrent' }), req.filename || 'torrent.torrent');
      await this.api({ action: 'add-file', ...target }, { method: 'POST', body: form });
    } else {
      await this.api({ action: 'add-url', s: req.url, ...target });
    }
    const hash = req.hash?.toUpperCase();
    if (hash) {
      if (req.category) await this.api({ action: 'setprops', hash, s: 'label', v: req.category }).catch(() => {});
      if (req.paused) await this.api({ action: 'stop', hash }).catch(() => {});
    }
    return { hash };
  }

  async poll() {
    const r = await this.api({ list: 1 });
    const torrents = (r.torrents || []).map((t) => {
      const [hash, status, name, size, permille, , , ratio, up, down, eta] = t;
      return {
        hash,
        name,
        state: this._state(status, permille, down),
        progress: permille / 1000,
        size,
        dlspeed: down,
        upspeed: up,
        eta: eta > 0 ? eta : null,
        ratio: ratio / 1000,
        addedOn: t[23] || 0,
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

  // Champ d'état : 1 démarré, 2 vérification, 16 erreur, 32 en pause, 64 en file.
  _state(status, permille, down) {
    if (status & 16) return 'error';
    if (status & 2) return 'checking';
    if (status & 32) return permille >= 1000 ? 'completed' : 'stopped';
    if (status & 1) return permille >= 1000 ? 'seeding' : down > 0 ? 'downloading' : 'stalled';
    if (status & 64) return 'queued';
    return permille >= 1000 ? 'completed' : 'stopped';
  }

  start(hash) { return this.api({ action: 'start', hash }); }
  stop(hash) { return this.api({ action: 'stop', hash }); }
}
