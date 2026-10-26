// Rangement automatique : trouve (ou prévoit) le bon dossier pour une série ou un film.
//
// Exemple : « Tulsa.King.S04E02.MULTi.1080p » avec un dossier des séries B:\Séries
//   → cherche un dossier « Tulsa King » dans B:\Séries (nom approchant accepté)
//   → cherche dedans un dossier de saison 4 (« Saison 4 », « Season 04 », « S04 »…)
//   → B:\Séries\Tulsa King\Saison 4, ou le chemin à créer s'il manque.
import { parseRelease, titleScore, parseSeasonFolder, seasonFolderName, prettyTitle } from './media.js';
import { joinPath, safeFolderName } from './clients/base.js';

const MIN_FOLDER_SCORE = 75;

async function list(client, path) {
  if (!client.caps.browse) return null;
  try {
    return await client.listDir(path);
  } catch (e) {
    if (e.code === 'NOT_FOUND') return [];
    return null;
  }
}

function bestFolder(dirs, title) {
  let best = null;
  for (const d of dirs) {
    const score = titleScore(d.name, title);
    if (score >= MIN_FOLDER_SCORE && (!best || score > best.score)) best = { ...d, score };
  }
  return best;
}

// Renvoie null si aucune règle ne s'applique, sinon :
// { kind, info, path, category, layout, verified, seriesName, seriesExists, seasonName, seasonExists }
export async function planDestination(client, cfg, name) {
  if (!cfg.autoOrganize) return null;
  const info = parseRelease(name);
  if (!info) return null;
  if (info.kind === 'movie') return cfg.moviesRoot ? planMovie(cfg, info) : null;
  const manual = manualFolder(cfg, info.title);
  if (!cfg.seriesRoot && !manual) return null;
  return planSeries(client, cfg, info, manual);
}

// Dossier choisi à la main pour une série suivie (fiche de la série, « Choisir le dossier »).
function manualFolder(cfg, title) {
  const show = (cfg.followed || []).find((s) => s.folder
    && [s.name, ...(s.aliases || [])].some((n) => titleScore(n, title) >= 90));
  return show ? { name: show.folder.split(/[\\/]/).filter(Boolean).pop(), path: show.folder } : null;
}

async function planSeries(client, cfg, info, manual) {
  const dirs = manual ? [] : await list(client, cfg.seriesRoot);
  const plan = {
    kind: info.kind,
    info,
    category: cfg.seriesCategory || '',
    layout: null,
    verified: dirs !== null,
  };

  const found = manual || (dirs ? bestFolder(dirs, info.title) : null);
  plan.seriesExists = Boolean(found);
  plan.seriesName = found ? found.name : safeFolderName(prettyTitle(info.title));
  const seriesPath = found ? found.path : joinPath(cfg.seriesRoot, plan.seriesName);

  // Intégrale ou plusieurs saisons : directement dans le dossier de la série.
  if (info.kind === 'series') {
    plan.path = seriesPath;
    return plan;
  }

  const seasons = found ? await list(client, seriesPath) : [];
  const season = (seasons || []).find((d) => parseSeasonFolder(d.name) === info.season);
  plan.seasonExists = Boolean(season);
  plan.seasonName = season ? season.name : seasonFolderName(info.season, cfg.seasonFormat, (seasons || []).map((d) => d.name));
  plan.path = season ? season.path : joinPath(seriesPath, plan.seasonName);
  // Les fichiers vont directement dans le dossier de saison, sans sous-dossier du torrent.
  if (cfg.flattenEpisodes) plan.layout = 'NoSubfolder';
  return plan;
}

function planMovie(cfg, info) {
  const folder = cfg.movieSubfolder ? safeFolderName(`${prettyTitle(info.title)}${info.year ? ` (${info.year})` : ''}`) : '';
  return {
    kind: 'movie',
    info,
    category: cfg.moviesCategory || '',
    layout: null,
    verified: false,
    path: folder ? joinPath(cfg.moviesRoot, folder) : cfg.moviesRoot,
    movieName: prettyTitle(info.title),
  };
}
