// Profil de qualité : choisit la meilleure release parmi plusieurs candidates.
//
// Règles par défaut :
//   1. 1080p obligatoire.
//   2. Source : WEB (WEBRip / WEB-DL), puis HDLight, puis BluRay en dernier recours.
//   3. Audio : EAC3 5.1, puis AC3 5.1, puis AAC 5.1 (le stéréo passe après).
//   4. À préférences égales, le fichier le plus léger.
//   5. Une version « Compact » (H264, audio standard, lisible partout sans
//      transcodage) est prise si elle ne pèse pas plus d'1 Go de plus que le
//      fichier le plus léger.
import { parseRelease, titleScore } from './media.js';

const GIB = 1024 ** 3;

export const DEFAULT_PROFILE = {
  resolution: '1080p',
  sources: ['web', 'hdlight', 'bluray'],
  audios: ['eac3', 'ac3', 'aac'],
  priority: 'source', // 'source' : la source compte avant l'audio ; 'audio' : l'inverse
  allowStereo: true,
  preferCompact: true,
  compactMargin: 1, // Go
};

export const SOURCE_LABELS = { web: 'WEB', hdlight: 'HDLight', bluray: 'BluRay', hdtv: 'HDTV', dvd: 'DVD' };
export const AUDIO_LABELS = { eac3: 'EAC3', ac3: 'AC3', aac: 'AAC', dts: 'DTS', truehd: 'TrueHD', opus: 'Opus', mp3: 'MP3' };

export const profileOf = (cfg) => ({ ...DEFAULT_PROFILE, ...(cfg?.profile || {}) });

// Délimiteurs d'un mot dans un nom de release (points, espaces, tirets…).
const word = (re) => new RegExp(`(?:^|[\\s._\\-\\[(])(?:${re})(?=$|[\\s._\\-\\])]|\\d)`, 'i');

const SOURCES = [
  ['hdlight', word('hd-?light|mhd|light')],
  ['bluray', word('blu-?ray|bdrip|brrip|bd-?remux|remux|bdmv|bd')],
  ['web', word('web-?dl|web-?rip|web|webhd|nf|amzn|dsnp|hmax|atvp|pcok')],
  ['hdtv', word('hdtv|tvrip|pdtv')],
  ['dvd', word('dvd-?rip|dvd|dvdr')],
];

const AUDIOS = [
  ['eac3', word('e-?ac-?3|ddp|dd\\+|dolby ?digital ?plus')],
  ['truehd', word('true-?hd|atmos')],
  ['dts', word('dts(?:-?hd)?(?:-?ma)?')],
  ['ac3', word('ac-?3|dd|dolby ?digital')],
  ['aac', word('aac')],
  ['opus', word('opus')],
  ['mp3', word('mp3')],
];

const pick = (list, s) => list.find(([, re]) => re.test(s))?.[0] || null;

// Caractéristiques techniques d'une release, d'après son nom.
export function analyzeRelease(title) {
  const t = title || '';
  const info = parseRelease(t);
  return {
    resolution: info?.quality || null,
    source: pick(SOURCES, t),
    audio: pick(AUDIOS, t),
    surround: /(?:^|[^\d])(?:5[ ._]?1|7[ ._]?1|6ch|8ch)(?:$|[^\d])/i.test(t),
    stereo: /(?:^|[^\d])(?:2[ ._]0|2ch|stereo)(?:$|[^\d])/i.test(t),
    compact: word('compact').test(t),
    codec: /x265|h\.?265|hevc/i.test(t) ? 'x265' : /x264|h\.?264|avc/i.test(t) ? 'x264' : /av1/i.test(t) ? 'av1' : null,
    lang: info?.lang || null,
  };
}

// Rang dans une liste de préférences : 0 = le mieux. Absent = après la liste.
const tierOf = (list, value, unknownRank) => {
  const i = list.indexOf(value);
  return i >= 0 ? i : unknownRank;
};

function describe(a, size) {
  const parts = [
    a.resolution,
    SOURCE_LABELS[a.source] || 'source ?',
    a.audio ? `${AUDIO_LABELS[a.audio] || a.audio}${a.surround ? ' 5.1' : a.stereo ? ' 2.0' : ''}` : 'audio ?',
  ];
  if (a.compact) parts.push('Compact');
  if (size) parts.push(`${(size / GIB).toFixed(2).replace('.', ',')} Go`);
  return parts.filter(Boolean).join(' · ');
}

// Classe les releases. Renvoie { best, ranked, rejected } ;
// chaque élément : { item, a (analyse), key, label, reason? }.
export function rankReleases(items, profile = DEFAULT_PROFILE) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  const ranked = [];
  const rejected = [];
  for (const item of items) {
    const a = analyzeRelease(item.title);
    const label = describe(a, item.size);
    if (p.resolution && a.resolution !== p.resolution) {
      rejected.push({ item, a, label, reason: a.resolution ? `${a.resolution} au lieu de ${p.resolution}` : 'résolution inconnue' });
      continue;
    }
    if (a.source && !p.sources.includes(a.source) && SOURCE_LABELS[a.source]) {
      rejected.push({ item, a, label, reason: `source ${SOURCE_LABELS[a.source]} exclue` });
      continue;
    }
    // Source inconnue : rangée après les sources listées.
    const source = tierOf(p.sources, a.source, p.sources.length);
    const audio = tierOf(p.audios, a.audio, p.audios.length);
    // Le stéréo ne passe qu'en dernier recours, quelle que soit la source :
    // 0 = 5.1 annoncé, 1 = canaux non précisés, 2 = stéréo (annoncé, ou AAC / MP3 sans précision).
    const channels = a.surround ? 0 : a.stereo || ['aac', 'mp3'].includes(a.audio) ? 2 : 1;
    if (channels === 2 && !p.allowStereo) {
      rejected.push({ item, a, label, reason: 'pas de 5.1' });
      continue;
    }
    const size = item.size || Number.MAX_SAFE_INTEGER;
    const key = p.priority === 'audio' ? [channels, audio, source, size] : [channels, source, audio, size];
    ranked.push({ item, a, key, label });
  }

  const cmp = (x, y) => {
    for (let i = 0; i < x.key.length; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
    return 0;
  };
  ranked.sort(cmp);
  let best = ranked[0] || null;
  if (best) best.reason = 'meilleure source et meilleur audio disponibles, au plus léger';

  // Règle Compact : prise dès qu'elle pèse au plus « marge » de plus que le fichier
  // le plus léger (parmi ceux du meilleur niveau audio : un stéréo écarté ne compte pas).
  if (best && p.preferCompact) {
    const compact = ranked.find((r) => r.a.compact);
    const lightest = Math.min(...ranked.filter((r) => r.key[0] === best.key[0]).map((r) => r.item.size || Number.MAX_SAFE_INTEGER));
    if (compact && compact !== best && (compact.item.size || 0) <= lightest + p.compactMargin * GIB) {
      const extra = Math.max(0, (compact.item.size - lightest) / GIB);
      compact.reason = `version Compact, seulement +${extra.toFixed(2).replace('.', ',')} Go par rapport au fichier le plus léger`;
      best = compact;
      ranked.splice(ranked.indexOf(compact), 1);
      ranked.unshift(compact);
    } else if (best.a.compact) {
      best.reason = 'version Compact, et déjà la meilleure';
    }
  }
  return { best, ranked, rejected };
}

// Les releases d'un indexeur qui correspondent bien à l'épisode (ou au film) voulu.
export function matchesEpisode(item, names, season, episode) {
  const info = parseRelease(item.title);
  if (!info || info.kind !== 'episode' || info.season !== season) return false;
  if (episode < info.episode || episode > (info.episodeEnd || info.episode)) return false;
  return names.some((n) => titleScore(n, info.title) >= 90);
}

export function matchesSeason(item, names, season) {
  const info = parseRelease(item.title);
  if (!info || info.kind !== 'season' || info.season !== season) return false;
  return names.some((n) => titleScore(n, info.title) >= 90);
}

export function matchesMovie(item, title, year, { trustId = false } = {}) {
  const info = parseRelease(item.title);
  if (info && ['episode', 'season', 'series'].includes(info.kind)) return false;
  if (trustId) return true;
  if (!info || info.kind !== 'movie') return false;
  if (year && info.year && Math.abs(info.year - year) > 1) return false;
  return titleScore(title, info.title) >= 85;
}
