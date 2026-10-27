// Nouveautés des indexeurs : lecture des flux RSS 2.0, Atom et Torznab (C411,
// Jackett, Prowlarr…), découverte du flux depuis la page d'un site, classement
// des sorties en films et séries. Sans DOMParser : les flux mal formés passent.

const TIMEOUT = 20000;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

function text(raw) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? cdata[1].trim() : decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

function tagAll(block, name) {
  return [...block.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => text(m[1]));
}

const tag = (block, name) => tagAll(block, name)[0] || '';

function attr(block, name, attribute) {
  const m = new RegExp(`<${name}\\b[^>]*?\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(block);
  return m ? decodeEntities(m[2]) : '';
}

// Attributs de chaque balise <name …> du bloc : [{ url, type, … }].
function elements(block, name) {
  return [...block.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map((m) => {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[3]);
    return attrs;
  });
}

// <torznab:attr name="seeders" value="12"/> → { seeders: ['12'] }
function torznabAttrs(block) {
  const out = {};
  for (const { name, value } of elements(block, '(?:torznab|newznab):attr')) {
    if (name) (out[name.toLowerCase()] ??= []).push(value ?? '');
  }
  return out;
}

const isHttp = (u) => /^https?:\/\//i.test(u || '');
const isMagnetUrl = (u) => /^magnet:\?/i.test(u || '');
const looksLikeTorrent = (u) => isMagnetUrl(u) || /\.torrent(\?|$)|\/download|passkey=|\/dl\/|[?&]file=/i.test(u || '');
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const isImage = (e) => /^image\//i.test(e.type || '') || e.medium === 'image';
// Images d'une description qui ne sont pas des affiches : smileys, icônes, compteurs…
const NOT_POSTER = /smil|emoji|emoticon|icon|logo|avatar|banner|button|pixel|spacer|rating|star|flag|\.gif(\?|$)/i;

function absolute(url, base) {
  if (!url) return '';
  try {
    const u = new URL(url, base || undefined).href;
    return isHttp(u) ? u : '';
  } catch {
    return '';
  }
}

// Affiche fournie par le flux : attribut Torznab, miniature Media RSS, pièce
// jointe image, ou première image de la description.
function feedPoster(block, tz, base) {
  const html = tag(block, 'content:encoded') || tag(block, 'description') || tag(block, 'summary') || tag(block, 'content');
  const inHtml = [...html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => decodeEntities(m[1])).find((src) => !NOT_POSTER.test(src));
  const candidates = [
    tz.coverurl?.[0],
    tz.poster?.[0],
    tz.posterurl?.[0],
    elements(block, 'media:thumbnail')[0]?.url,
    elements(block, 'media:content').find(isImage)?.url,
    elements(block, 'enclosure').find(isImage)?.url,
    attr(block, 'itunes:image', 'href'),
    inHtml,
  ];
  for (const c of candidates) {
    const url = absolute(c, base);
    if (url) return url;
  }
  return '';
}

// Identifiant IMDb : attribut Torznab (« 0111161 » ou « tt0111161 ») ou lien imdb.com.
function imdbId(block, tz) {
  const raw = tz.imdbid?.[0] || tz.imdb?.[0] || /imdb\.com\/title\/(tt\d{5,})/i.exec(block)?.[1] || '';
  const digits = /(\d{5,})/.exec(raw)?.[1];
  return digits && Number(digits) > 0 ? `tt${digits.padStart(7, '0')}` : '';
}

export function parseFeed(xml, base = '') {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const itemRe = atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = [...xml.matchAll(itemRe)].map((m) => m[0]);
  const first = xml.search(atom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = first >= 0 ? xml.slice(0, first) : xml;

  const items = blocks.map((b) => {
    const tz = torznabAttrs(b);
    const title = tag(b, 'title');
    const link = atom ? attr(b, 'link', 'href') : tag(b, 'link');
    const enclosure = elements(b, 'enclosure').find((e) => !isImage(e))?.url || '';
    const magnet = tz.magneturl?.[0] || '';
    const guid = tag(b, 'guid') || tag(b, 'id');
    const comments = tag(b, 'comments');
    const torrentUrl = [enclosure, looksLikeTorrent(link) ? link : '', magnet, looksLikeTorrent(guid) ? guid : '']
      .find((u) => isHttp(u) || isMagnetUrl(u)) || '';
    // Page du torrent : commentaires (Torznab), sinon guid ou lien s'ils ne mènent pas au .torrent.
    const details = [comments, guid, link].find((u) => isHttp(u) && u !== torrentUrl && !looksLikeTorrent(u))
      || [comments, link, guid].find(isHttp) || '';
    const pub = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const size = num(tz.size?.[0]) || num(elements(b, 'enclosure').find((e) => !isImage(e))?.length) || num(tag(b, 'size')) || null;
    const seeders = num(tz.seeders?.[0]);
    const peers = num(tz.peers?.[0]);
    const item = {
      guid: guid || torrentUrl || details || title,
      title,
      link: details,
      torrentUrl,
      date: Date.parse(pub) || null,
      size,
      seeders,
      leechers: peers != null && seeders != null ? Math.max(0, peers - seeders) : num(tz.leechers?.[0]),
      categories: [...(tz.category || []), ...tagAll(b, 'category')].filter(Boolean),
      poster: feedPoster(b, tz, base),
      imdbId: imdbId(b, tz),
    };
    item.type = mediaType(item);
    return item;
  }).filter((i) => i.title);

  const channelLink = atom ? attr(head, 'link', 'href') : tag(head, 'link');
  return { title: tag(head, 'title'), link: isHttp(channelLink) ? channelLink : '', items };
}

// --- Films et séries ----------------------------------------------------------

const TV_TITLE = /\b(S\d{1,2}(?:[ ._-]?E\d{1,3})*|S\d{1,2}[ ._-]?-[ ._-]?S?\d{1,2}|\d{1,2}x\d{2,3}|saisons?[ ._-]*\d+|seasons?[ ._-]*\d+|int[ée]grale|complete[ ._-]series)\b/i;
const VIDEO_TITLE = /\b(2160p|1080[pi]|720p|576p|480p|4k|uhd|blu-?ray|bdrip|brrip|remux|web-?dl|webrip|web|hdtv|hdrip|dvdrip|hdlight|mhd|x26[45]|h\.?26[45]|hevc|av1)\b/i;
const YEAR = /\b(19[2-9]\d|20[0-4]\d)\b/;

// 'movie' | 'tv' | 'other'. Catégories Torznab d'abord (2000 films, 5000 séries),
// puis libellés de catégorie, puis nom de la release.
export function mediaType({ title, categories = [] }) {
  for (const c of categories) {
    if (/^5\d{3}$/.test(c)) return 'tv';
    if (/^2\d{3}$/.test(c)) return 'movie';
  }
  const label = categories.join(' / ');
  if (/s[ée]ries?|\btv\b|t[ée]l[ée]|[ée]missions?|\bshows?\b/i.test(label)) return 'tv';
  if (TV_TITLE.test(title)) return 'tv';
  if (/\bfilms?\b|\bmovies?\b/i.test(label)) return 'movie';
  if (YEAR.test(title) && VIDEO_TITLE.test(title)) return 'movie';
  return 'other';
}

// Pastilles affichées à côté d'une release : définition et langue.
export function releaseTags(title) {
  const tags = [];
  if (/\b(2160p|4k|uhd)\b/i.test(title)) tags.push('4K');
  else if (/\b1080[pi]\b/i.test(title)) tags.push('1080p');
  else if (/\b720p\b/i.test(title)) tags.push('720p');
  if (/\bmulti\b/i.test(title)) tags.push('MULTi');
  else if (/\b(vostfr|subfrench|vost)\b/i.test(title)) tags.push('VOSTFR');
  else if (/\b(truefrench|french|vff|vfq|vfi|vf2?)\b/i.test(title)) tags.push('VF');
  return tags;
}

// --- Récupération -------------------------------------------------------------

// Torznab : clé API renseignée ou adresse d'API reconnaissable.
export function isTorznab(ix) {
  return Boolean(ix.apikey) || /torznab|\/api\/v\d|:9117\b|:9696\b/i.test(ix.url || '');
}

export function resolveUrl(ix) {
  if (!isTorznab(ix)) return ix.url;
  const url = new URL(ix.url);
  // Jackett (…/results/torznab/) et Prowlarr (…:9696/1/) : l'API est sous /api.
  if (/\/results\/torznab\/?$/i.test(url.pathname) || /^\/\d+\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api`;
  }
  const p = url.searchParams;
  if (!p.has('t')) p.set('t', 'search');
  if (ix.content !== 'all' && !p.has('cat')) p.set('cat', '2000,5000');
  if (!p.has('limit')) p.set('limit', '100');
  if (ix.apikey && !p.has('apikey')) p.set('apikey', ix.apikey);
  return url.href;
}

// Les flux de certains sites français sont en ISO-8859-1 : on respecte l'encodage
// annoncé (en-tête HTTP, déclaration XML ou balise meta).
async function readText(res) {
  const buf = await res.arrayBuffer();
  let charset = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1];
  if (!charset) {
    const head = new TextDecoder('windows-1252').decode(buf.slice(0, 2048));
    charset = /<\?xml[^>]*encoding=["']([\w-]+)/i.exec(head)?.[1] || /<meta[^>]*charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder().decode(buf);
  }
}

const torznabError = (body) => /<error\b[^>]*description\s*=\s*["']([^"']+)["']/i.exec(body)?.[1];
const isCloudflare = (body) => /cf-browser-verification|challenge-platform|cf_chl_|<title>Just a moment/i.test(body);
const isFeed = (body) => /<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 5000));

function httpError(status, body) {
  if (isCloudflare(body)) return 'Le site est protégé par Cloudflare. Ouvre-le une fois dans Chrome, puis réessaie.';
  const detail = torznabError(body);
  const suffix = detail ? ` — ${decodeEntities(detail)}` : '';
  if (status === 401 || status === 403) return `Accès refusé (HTTP ${status})${suffix}. Clé API ou passkey incorrecte, ou connexion au site requise.`;
  if (status === 404) return "Adresse introuvable (HTTP 404). Vérifie l'adresse du flux.";
  if (status === 429) return 'Trop de requêtes : le site limite les accès, réessaie dans quelques minutes.';
  return `Le site a répondu HTTP ${status}${suffix}.`;
}

async function get(url) {
  let res;
  try {
    res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5' },
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Le site ne répond pas (délai dépassé).' : "Site injoignable. Vérifie l'adresse.");
  }
  const body = await readText(res);
  if (!res.ok) throw new Error(httpError(res.status, body));
  return { body, url: res.url || url };
}

// Lien <link rel="alternate" type="application/rss+xml"> d'une page HTML.
function discover(html, base) {
  for (const [tagHtml] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel\s*=\s*["']?alternate/i.test(tagHtml) || !/application\/(rss|atom)\+xml/i.test(tagHtml)) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tagHtml)?.[1];
    try {
      if (href) return new URL(decodeEntities(href), base).href;
    } catch { /* adresse invalide */ }
  }
  return null;
}

function origin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// Dernières sorties d'un indexeur, de la plus récente à la plus ancienne.
// `discovered` : adresse du flux trouvée sur la page, si l'adresse était celle du site.
export async function fetchIndexer(ix) {
  let res = await get(resolveUrl(ix));
  let discovered = null;
  if (!isFeed(res.body)) {
    const error = torznabError(res.body);
    if (error) throw new Error(`L'indexeur a répondu : ${decodeEntities(error)}`);
    if (isCloudflare(res.body)) throw new Error(httpError(200, res.body));
    discovered = discover(res.body, res.url);
    if (!discovered) {
      throw new Error("Aucun flux trouvé à cette adresse. Colle l'adresse du flux RSS de l'indexeur (souvent avec ta passkey) ou son adresse Torznab.");
    }
    res = await get(discovered);
    if (!isFeed(res.body)) throw new Error('Le flux annoncé par la page est illisible.');
  }

  const feed = parseFeed(res.body, res.url);
  let items = feed.items;
  if (ix.content !== 'all') items = items.filter((i) => i.type !== 'other');
  if (items.some((i) => i.date)) items = items.slice().sort((a, b) => (b.date || 0) - (a.date || 0));

  const firstLink = feed.items.find((i) => isHttp(i.link))?.link;
  return {
    title: feed.title,
    site: origin(feed.link) || origin(firstLink) || origin(ix.url),
    kind: isTorznab(ix) ? 'torznab' : /<feed[\s>]/i.test(res.body) ? 'atom' : 'rss',
    discovered,
    total: feed.items.length,
    items,
  };
}

// Nom proposé pour un nouvel indexeur : titre du flux nettoyé, sinon le domaine.
export function suggestName(feedTitle, url) {
  const clean = (feedTitle || '').replace(/\s*[-|:–]\s*(rss|flux|feed|torznab|jackett|prowlarr).*$/i, '').trim();
  if (clean && clean.length <= 40) return clean;
  try {
    return new URL(url).hostname.replace(/^www\d*\./, '');
  } catch {
    return 'Indexeur';
  }
}
