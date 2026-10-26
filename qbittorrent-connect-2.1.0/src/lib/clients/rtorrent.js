// rTorrent — XML-RPC (point d'accès /RPC2 ou plugin RPC de ruTorrent).
import { TorrentClient, ClientError, basicAuth, toBase64 } from './base.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

function xmlValue(v) {
  if (v instanceof Uint8Array) return `<value><base64>${toBase64(v)}</base64></value>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `<value><i8>${v}</i8></value>` : `<value><double>${v}</double></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(xmlValue).join('')}</data></array></value>`;
  return `<value><string>${esc(String(v))}</string></value>`;
}

export function xmlrpcRequest(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
    params.map((p) => `<param>${xmlValue(p)}</param>`).join('')}</params></methodCall>`;
}

// Petit analyseur XML-RPC : pas de DOMParser dans le service d'arrière-plan.
export function xmlrpcParse(xml) {
  const tokens = [];
  for (const m of xml.matchAll(/<(\/?)([a-zA-Z][\w.:-]*)[^>]*?(\/?)>|([^<]+)/g)) {
    if (m[4] !== undefined) tokens.push({ text: m[4] });
    else tokens.push({ close: Boolean(m[1]), name: m[2], self: Boolean(m[3]) });
  }
  let i = tokens.findIndex((t) => t.name === 'methodResponse');
  if (i < 0) throw new ClientError('Réponse XML-RPC invalide.', 'RPC');
  const fail = (what) => { throw new ClientError(`Réponse XML-RPC invalide (${what}).`, 'RPC'); };
  const skipWs = () => { while (tokens[i]?.text !== undefined && !tokens[i].text.trim()) i++; };
  const open = (name) => { skipWs(); const t = tokens[i++]; if (!t || t.close || t.name !== name) fail(`<${name}>`); return t; };
  const close = (name) => { skipWs(); const t = tokens[i++]; if (!t || !t.close || t.name !== name) fail(`</${name}>`); };
  const isClose = (name) => { skipWs(); return tokens[i]?.close && tokens[i].name === name; };
  const text = (name) => {
    let s = '';
    while (tokens[i]?.text !== undefined) s += tokens[i++].text;
    close(name);
    return unesc(s);
  };

  function value() {
    const v0 = open('value');
    if (v0.self) return '';
    // Une valeur sans type est une chaîne.
    if (tokens[i]?.text !== undefined && tokens[i + 1]?.close && tokens[i + 1].name === 'value') {
      const s = unesc(tokens[i].text);
      i += 2;
      return s;
    }
    if (isClose('value')) { i++; return ''; }
    const t = tokens[i++];
    let v;
    switch (t.name) {
      case 'string': v = t.self ? '' : text('string'); break;
      case 'i4': case 'i8': case 'int': v = Number(text(t.name)); break;
      case 'double': v = Number(text('double')); break;
      case 'boolean': v = text('boolean').trim() === '1'; break;
      case 'base64': v = text('base64'); break;
      case 'nil': v = null; if (!t.self) close('nil'); break;
      case 'array': {
        v = [];
        const data = open('data');
        if (!data.self) {
          while (!isClose('data')) v.push(value());
          i++;
        }
        close('array');
        break;
      }
      case 'struct':
        v = {};
        while (!isClose('struct')) {
          open('member');
          open('name');
          const key = text('name');
          v[key] = value();
          close('member');
        }
        i++;
        break;
      default: fail(t.name);
    }
    close('value');
    return v;
  }

  i++;
  skipWs();
  if (tokens[i]?.name === 'fault') {
    i++;
    const f = value();
    throw new ClientError(`rTorrent : ${f.faultString || 'erreur'}`, 'FAULT');
  }
  open('params');
  open('param');
  return value();
}

const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export class RTorrent extends TorrentClient {
  static meta = {
    id: 'rtorrent',
    label: 'rTorrent / ruTorrent',
    description: "rTorrent via XML-RPC : /RPC2, ou /plugins/rpc/rpc.php avec ruTorrent.",
    placeholder: 'http://192.168.1.20',
    fields: ['username', 'password', 'rpcPath'],
    rpcPath: '/RPC2',
    beta: true,
  };

  static caps = { browse: false, categories: true, categoryPaths: false, startStop: true };

  get endpoint() { return this.base + (this.cfg.rpcPath || RTorrent.meta.rpcPath); }

  async call(method, ...params) {
    const headers = { 'Content-Type': 'text/xml' };
    const auth = basicAuth(this.cfg.username, this.cfg.password);
    if (auth) headers.Authorization = auth;
    const res = await this.fetch(this.endpoint, { method: 'POST', headers, body: xmlrpcRequest(method, params) });
    if (res.status === 401) throw new ClientError("Nom d'utilisateur ou mot de passe incorrect.", 'AUTH', 401);
    if (!res.ok) throw new ClientError(`rTorrent : HTTP ${res.status} sur ${this.endpoint}`, 'HTTP', res.status);
    return xmlrpcParse(await res.text());
  }

  async test() {
    const v = await this.call('system.client_version');
    return { version: `rTorrent ${v}`, detail: '' };
  }

  async defaults() {
    return { savePath: await this.call('directory.default').catch(() => '') };
  }

  async categories() {
    const { torrents } = await this.poll();
    return Object.fromEntries([...new Set(torrents.map((t) => t.label).filter(Boolean))].map((l) => [l, { savePath: '' }]));
  }

  async exists(hash) {
    try { return await this.call('d.name', hash.toUpperCase()); } catch { return null; }
  }

  async add(req) {
    const cmds = [`d.custom.set=addtime,${Math.floor(Date.now() / 1000)}`];
    if (req.savePath) cmds.push(`d.directory.set=${quote(req.savePath)}`);
    // ruTorrent enregistre les étiquettes encodées en URI dans d.custom1.
    if (req.category) cmds.push(`d.custom1.set=${quote(encodeURIComponent(req.category))}`);
    if (req.torrent) await this.call(req.paused ? 'load.raw' : 'load.raw_start', '', req.torrent, ...cmds);
    else await this.call(req.paused ? 'load.normal' : 'load.start', '', req.url, ...cmds);
    return { hash: req.hash };
  }

  async _rows() {
    const fields = ['d.hash=', 'd.name=', 'd.size_bytes=', 'd.completed_bytes=', 'd.down.rate=', 'd.up.rate=',
      'd.state=', 'd.is_active=', 'd.complete=', 'd.ratio=', 'd.is_hash_checking=', 'd.custom1=', 'd.custom=addtime'];
    try {
      return await this.call('d.multicall2', '', 'main', ...fields);
    } catch (e) {
      if (e.code !== 'FAULT') throw e;
      return this.call('d.multicall', 'main', ...fields); // rTorrent < 0.9.7
    }
  }

  async poll() {
    const [rows, down, up] = await Promise.all([
      this._rows(),
      this.call('throttle.global_down.rate').catch(() => 0),
      this.call('throttle.global_up.rate').catch(() => 0),
    ]);
    return {
      server: { dlSpeed: down, upSpeed: up, freeSpace: null, altSpeed: null, connection: 'connected' },
      torrents: rows.map(([hash, name, size, done, dl, ul, state, active, complete, ratio, hashing, label, added]) => {
        let st;
        if (hashing) st = 'checking';
        else if (!state || !active) st = complete ? 'completed' : 'stopped';
        else if (complete) st = 'seeding';
        else st = dl > 0 ? 'downloading' : 'stalled';
        let decoded = label;
        try { decoded = decodeURIComponent(label); } catch { /* étiquette brute */ }
        return {
          hash,
          name,
          state: st,
          progress: size ? done / size : 0,
          size,
          dlspeed: dl,
          upspeed: ul,
          eta: dl > 0 ? Math.round((size - done) / dl) : null,
          ratio: ratio / 1000,
          addedOn: Number(added) || 0,
          label: decoded,
        };
      }),
    };
  }

  async start(hash) {
    await this.call('d.open', hash);
    await this.call('d.start', hash);
  }

  async stop(hash) {
    await this.call('d.stop', hash);
    await this.call('d.close', hash);
  }
}
