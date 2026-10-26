// Lecture des flux RSS 2.0, Atom et Torznab, sans DOMParser
// (indisponible dans le service d'arrière-plan d'une extension).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function text(raw) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? cdata[1].trim() : decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? text(m[1]) : '';
}

function attr(block, name, attribute) {
  const m = new RegExp(`<${name}\\b[^>]*?\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(block);
  return m ? decodeEntities(m[2]) : '';
}

function torznab(block, name) {
  const re = new RegExp(`<(?:torznab|newznab):attr\\b[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i');
  const m = re.exec(block);
  return m ? decodeEntities(m[1]) : '';
}

// Message lisible pour une réponse en erreur : Torznab (<error description="…">),
// JSON ({ message }) ou simple code HTTP.
export function feedError(status, body = '') {
  const torznab = /<error[^>]*description=["']([^"']+)["']/i.exec(body)?.[1];
  let json = null;
  try { json = JSON.parse(body)?.message; } catch { /* pas du JSON */ }
  const detail = torznab || json;
  const hint = status === 401 || status === 403 || /api ?key/i.test(detail || '')
    ? " : la clé de l'adresse n'est pas acceptée (clé API manquante, fausse ou régénérée)"
    : '';
  return `HTTP ${status}${detail ? ` — ${detail}` : ''}${hint}`;
}

const isHttp = (u) => /^https?:\/\//i.test(u || '');
const looksLikeTorrent = (u) => /^magnet:/i.test(u) || /\.torrent(\?|$)|\/download|passkey=|\/dl\//i.test(u || '');

export function parseFeed(xml) {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const head = xml.slice(0, xml.search(atom ? /<entry[\s>]/i : /<item[\s>]/i) >>> 0);

  const items = blocks.map((b) => {
    const title = tag(b, 'title');
    const link = atom ? attr(b, 'link', 'href') : tag(b, 'link');
    const enclosure = attr(b, 'enclosure', 'url');
    const magnet = torznab(b, 'magneturl');
    const guid = tag(b, 'guid') || tag(b, 'id');
    const comments = tag(b, 'comments');
    const torrentUrl = enclosure || (looksLikeTorrent(link) ? link : '') || magnet || (looksLikeTorrent(guid) ? guid : '') || link;
    // Page de détails : commentaires, sinon guid ou lien s'ils ne pointent pas vers le .torrent.
    const details = [comments, guid, link].find((u) => isHttp(u) && u !== torrentUrl) || link;
    const pub = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const size = Number(attr(b, 'enclosure', 'length')) || Number(torznab(b, 'size')) || Number(tag(b, 'size')) || 0;
    return {
      guid: guid || torrentUrl || title,
      title,
      link: details,
      torrentUrl,
      pubDate: Date.parse(pub) || null,
      size,
      category: tag(b, 'category'),
    };
  }).filter((i) => i.title);

  return { title: tag(head, 'title'), items };
}
