// Lecture des fichiers .torrent (bencode) et des liens magnet.

const utf8 = new TextDecoder('utf-8');

function ascii(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function str(value) {
  if (value instanceof Uint8Array) return utf8.decode(value);
  return value == null ? '' : String(value);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Décode un bencode et renvoie aussi les octets bruts du dictionnaire "info"
// (nécessaires pour calculer l'info hash).
export function bdecode(bytes) {
  let pos = 0;
  let infoStart = -1;
  let infoEnd = -1;
  const len = bytes.length;
  const fail = (what) => { throw new Error(`Fichier torrent invalide (${what}, octet ${pos})`); };

  function parseString() {
    const colon = bytes.indexOf(0x3a, pos);
    if (colon < 0) fail('chaîne');
    const n = Number(ascii(bytes.subarray(pos, colon)));
    if (!Number.isInteger(n) || n < 0) fail('longueur');
    const start = colon + 1;
    const end = start + n;
    if (end > len) fail('chaîne tronquée');
    pos = end;
    return bytes.subarray(start, end);
  }

  function parse(depth) {
    if (pos >= len) fail('fin inattendue');
    const c = bytes[pos];
    if (c === 0x69) { // i<n>e
      const end = bytes.indexOf(0x65, pos);
      if (end < 0) fail('entier');
      const n = Number(ascii(bytes.subarray(pos + 1, end)));
      if (!Number.isFinite(n)) fail('entier');
      pos = end + 1;
      return n;
    }
    if (c === 0x6c) { // l…e
      pos++;
      const list = [];
      while (pos < len && bytes[pos] !== 0x65) list.push(parse(depth + 1));
      if (pos >= len) fail('liste');
      pos++;
      return list;
    }
    if (c === 0x64) { // d…e
      pos++;
      const dict = Object.create(null);
      while (pos < len && bytes[pos] !== 0x65) {
        const key = utf8.decode(parseString());
        const valueStart = pos;
        dict[key] = parse(depth + 1);
        if (depth === 0 && key === 'info') {
          infoStart = valueStart;
          infoEnd = pos;
        }
      }
      if (pos >= len) fail('dictionnaire');
      pos++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) return parseString();
    return fail('caractère inattendu');
  }

  const root = parse(0);
  return { root, infoBytes: infoStart >= 0 ? bytes.subarray(infoStart, infoEnd) : null };
}

export async function parseTorrent(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] !== 0x64) throw new Error("Ce fichier n'est pas un torrent.");
  const { root, infoBytes } = bdecode(bytes);
  const info = root?.info;
  if (!info || !infoBytes) throw new Error("Ce fichier n'est pas un torrent valide (pas de section info).");

  const name = str(info['name.utf-8'] ?? info.name) || 'Sans nom';
  const files = [];

  if (Array.isArray(info.files)) {
    // Torrent v1 multi-fichiers. Les fichiers de bourrage (BEP 47) sont ignorés,
    // comme le fait qBittorrent pour numéroter les fichiers.
    for (const f of info.files) {
      const parts = (f['path.utf-8'] ?? f.path ?? []).map(str);
      if (str(f.attr).includes('p') || parts[0] === '.pad') continue;
      files.push({ index: files.length, path: [name, ...parts].join('/'), size: f.length || 0 });
    }
  } else if (typeof info.length === 'number') {
    files.push({ index: 0, path: name, size: info.length });
  } else if (info['file tree']) {
    // Torrent v2 uniquement.
    const walk = (node, parts) => {
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (key === '') {
          if (!str(child.attr).includes('p')) {
            files.push({ index: files.length, path: parts.join('/'), size: child.length || 0 });
          }
        } else {
          walk(child, [...parts, key]);
        }
      }
    };
    const tree = info['file tree'];
    const keys = Object.keys(tree);
    const single = keys.length === 1 && tree[keys[0]][''];
    walk(tree, single ? [] : [name]);
  }

  const isV1 = info.pieces instanceof Uint8Array;
  const isV2 = info['meta version'] === 2;
  const hashV1 = isV1 ? hex(await crypto.subtle.digest('SHA-1', infoBytes)) : null;
  const hashV2 = isV2 ? hex(await crypto.subtle.digest('SHA-256', infoBytes)) : null;

  const trackers = new Set();
  if (root.announce) trackers.add(str(root.announce));
  for (const tier of root['announce-list'] || []) for (const t of tier) trackers.add(str(t));

  return {
    name,
    files,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    comment: str(root['comment.utf-8'] ?? root.comment),
    createdBy: str(root['created by']),
    creationDate: typeof root['creation date'] === 'number' ? root['creation date'] : null,
    isPrivate: info.private === 1,
    trackers: [...trackers],
    hashV1,
    hashV2,
    // Identifiant utilisé par qBittorrent : hash v1, ou hash v2 tronqué pour un torrent v2 pur.
    id: hashV1 || hashV2.slice(0, 40),
  };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(s) {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let out = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) out += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return out;
}

export function isMagnet(url) {
  return /^magnet:\?/i.test(url || '');
}

export function parseMagnet(uri) {
  const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  let hashV1 = null;
  let hashV2 = null;
  for (const xt of params.getAll('xt')) {
    const v1 = /^urn:btih:([a-z0-9]+)$/i.exec(xt);
    if (v1) hashV1 = (v1[1].length === 32 ? base32ToHex(v1[1]) : v1[1])?.toLowerCase() || null;
    const v2 = /^urn:btmh:1220([0-9a-f]{64})$/i.exec(xt);
    if (v2) hashV2 = v2[1].toLowerCase();
  }
  const id = hashV1 || hashV2?.slice(0, 40) || null;
  return {
    uri,
    name: params.get('dn') || id || 'Lien magnet',
    hashV1,
    hashV2,
    id,
    trackers: params.getAll('tr'),
  };
}

const UNITS = ['o', 'Kio', 'Mio', 'Gio', 'Tio', 'Pio'];

export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'N/D';
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSec) {
  return `${formatSize(bytesPerSec)}/s`;
}
