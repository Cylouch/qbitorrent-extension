import { Qbt } from '../lib/qbt.js';
import { getConfig } from '../lib/config.js';
import { $, hydrateIcons } from '../lib/ui.js';
import { initTheme, bindThemeButton } from '../lib/theme.js';
import { baseName } from '../lib/paths.js';
import { Explorer } from '../ui/explorer.js';

const TITLE = 'Explorateur du serveur';

function showError(text, settings = false) {
  $('bannerText').textContent = text;
  $('bannerBtn').hidden = !settings;
  $('banner').hidden = false;
}

async function init() {
  hydrateIcons();
  await initTheme();
  bindThemeButton($('themeBtn'));
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('feedsBtn').addEventListener('click', () => { location.href = chrome.runtime.getURL('src/feeds/feeds.html'); });
  $('bannerBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  const cfg = await getConfig();
  if (!cfg.serverUrl) {
    $('serverDot').className = 'dot err';
    $('server').textContent = 'Non configuré';
    $('explorer').hidden = true;
    showError("Aucun serveur qBittorrent n'est configuré.", true);
    return;
  }
  const host = new URL(cfg.serverUrl).host;
  $('server').textContent = host;
  const qbt = new Qbt(cfg);
  qbt.version().then((v) => {
    $('serverDot').className = 'dot ok';
    $('server').textContent = `${host} · ${v}`;
  }, (e) => {
    $('serverDot').className = 'dot err';
    $('server').textContent = 'Hors ligne';
    showError(`Connexion à qBittorrent impossible : ${e.message}`);
  });

  new Explorer($('explorer'), {
    qbt,
    cfg,
    initial: new URLSearchParams(location.search).get('path') || '',
    // L'adresse de la page suit le dossier ouvert (rechargement, favoris).
    onNavigate: (path) => {
      const url = new URL(location.href);
      if (path) url.searchParams.set('path', path);
      else url.searchParams.delete('path');
      history.replaceState(null, '', url);
      document.title = path ? `${baseName(path) || path} — ${TITLE}` : TITLE;
    },
  });
}

init();
