import { Qbt } from '../lib/qbt.js';
import { DEFAULTS, getConfig, setConfig, normalizeUrl } from '../lib/config.js';
import { icon } from '../lib/icons.js';
import { $, esc, hydrateIcons, toast } from '../lib/ui.js';
import { initTheme } from '../lib/theme.js';

const SECTIONS = ['serveur', 'apparence', 'ajout', 'interception', 'popup', 'apropos'];
const KEEP_ON_RESET = ['serverUrl', 'username', 'password'];
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

function showSection(id) {
  if (!SECTIONS.includes(id)) id = 'serveur';
  for (const s of SECTIONS) $(`s-${s}`).hidden = s !== id;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.hash === `#${id}`));
  window.scrollTo(0, 0);
}

function setSideStatus(kind, text) {
  $('sideDot').className = `dot ${kind}`;
  $('sideText').textContent = text;
}

function showResult(kind, title, text, extra = '') {
  const ico = kind === 'info' ? '<span class="spinner"></span>' : icon(kind === 'ok' ? 'checkCircle' : 'alert');
  $('result').className = `card result ${kind}`;
  $('result').innerHTML = `<span class="r-ico">${ico}</span><div class="grow"><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;
  $('result').hidden = false;
}

function fillCategories(names, current) {
  const sel = $('defaultCategory');
  sel.innerHTML = '';
  sel.append(new Option('Aucune', ''));
  for (const name of [...names].sort(collator.compare)) sel.append(new Option(name, name));
  if (current && !names.includes(current)) sel.append(new Option(current, current));
  sel.value = current || '';
}

async function testConnection(cfg) {
  showResult('info', 'Connexion en cours…', cfg.serverUrl);
  setSideStatus('wait', 'Connexion…');
  try {
    const qbt = new Qbt(cfg);
    await qbt.login();
    const [version, api, categories] = await Promise.all([qbt.version(), qbt.apiVersion(), qbt.categories()]);
    const names = Object.keys(categories || {});
    showResult('ok', 'Connecté', `qBittorrent ${version} · API ${api}`, `
      <div class="stats">
        <span class="chip">${icon('globe')}${esc(new URL(cfg.serverUrl).host)}</span>
        <span class="chip">${icon('folder')}${names.length} catégorie${names.length > 1 ? 's' : ''}</span>
      </div>`);
    setSideStatus('ok', `Connecté · ${version}`);
    fillCategories(names, (await getConfig()).defaultCategory);
    $('catHint').textContent = names.length ? "Présélectionnée dans la fenêtre d'ajout" : 'Aucune catégorie sur le serveur';
  } catch (e) {
    showResult('error', 'Connexion impossible', e.message);
    setSideStatus('err', 'Erreur de connexion');
  }
}

function bindSettings(cfg) {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = Boolean(cfg[key]);
    else if (el.type === 'radio') el.checked = String(cfg[key]) === el.value;
    else el.value = String(cfg[key]);

    el.addEventListener('change', async () => {
      if (el.type === 'radio' && !el.checked) return;
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (typeof DEFAULTS[key] === 'number') value = Number(value);
      await setConfig({ [key]: value });
      toast('Réglage enregistré', 'ok');
    });
  });
}

function updateRecent(paths) {
  $('recentHint').textContent = paths.length
    ? `${paths.length} emplacement${paths.length > 1 ? 's' : ''} mémorisé${paths.length > 1 ? 's' : ''}`
    : 'Aucun emplacement mémorisé';
  $('clearRecent').disabled = !paths.length;
}

async function showFileAccess() {
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  $('fileAccessChip').className = `chip ${allowed ? 'ok' : 'warn'}`;
  $('fileAccessChip').innerHTML = `${icon(allowed ? 'check' : 'alert')}${allowed ? 'Activé' : 'Désactivé'}`;
  $('fileAccessText').textContent = allowed
    ? "L'extension lit directement le .torrent téléchargé : ça marche même avec les liens à usage unique des trackers privés."
    : "L'extension retélécharge le .torrent depuis le site, avec tes cookies. Pour plus de fiabilité, active « Autoriser l'accès aux URL de fichier » sur la page de l'extension.";
}

async function main() {
  hydrateIcons();
  await initTheme();
  const cfg = await getConfig();
  const version = chrome.runtime.getManifest().version;
  $('version').textContent = `Version ${version}`;
  $('aboutVersion').textContent = `Version ${version}`;

  showSection(location.hash.slice(1));
  window.addEventListener('hashchange', () => showSection(location.hash.slice(1)));

  // Serveur
  $('serverUrl').value = cfg.serverUrl;
  $('username').value = cfg.username;
  $('password').value = cfg.password;
  $('pwToggle').addEventListener('click', () => {
    const show = $('password').type === 'password';
    $('password').type = show ? 'text' : 'password';
    $('pwToggle').innerHTML = icon(show ? 'eyeOff' : 'eye');
    $('pwToggle').title = show ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
  });
  $('serverForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {
      serverUrl: normalizeUrl($('serverUrl').value),
      username: $('username').value.trim(),
      password: $('password').value,
    };
    $('serverUrl').value = patch.serverUrl;
    $('saveBtn').disabled = true;
    await setConfig(patch);
    await testConnection(patch);
    $('saveBtn').disabled = false;
  });
  $('openWebui').addEventListener('click', async () => {
    const { serverUrl } = await getConfig();
    if (serverUrl) chrome.tabs.create({ url: `${serverUrl}/` });
    else toast("Indique d'abord l'adresse du serveur", 'error');
  });

  // Réglages génériques
  fillCategories([], cfg.defaultCategory);
  bindSettings(cfg);

  updateRecent(cfg.recentPaths);
  $('clearRecent').addEventListener('click', async () => {
    await setConfig({ recentPaths: [] });
    updateRecent([]);
    toast('Emplacements récents effacés', 'ok');
  });

  $('openExt').addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
  showFileAccess();
  window.addEventListener('focus', showFileAccess);

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Réinitialiser tous les réglages ? Le serveur et les identifiants sont conservés.')) return;
    const patch = Object.fromEntries(Object.entries(DEFAULTS).filter(([k]) => !KEEP_ON_RESET.includes(k)));
    await setConfig(patch);
    location.reload();
  });

  if (cfg.serverUrl) testConnection(cfg);
  else setSideStatus('', 'Non configuré');
}

main();
