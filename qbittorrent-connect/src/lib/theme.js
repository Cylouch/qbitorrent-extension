import { getConfig, setConfig } from './config.js';
import { icon } from './icons.js';

// Copie locale des réglages d'apparence, relue par theme-boot.js avant le premier
// affichage pour éviter un flash de la mauvaise couleur.
const CACHE_KEY = 'qbc-ui';
const KEYS = ['theme', 'accent', 'density', 'animations'];

export const THEME_NEXT = { system: 'light', light: 'dark', dark: 'system' };
export const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
export const THEME_LABEL = { system: 'Thème : système', light: 'Thème : clair', dark: 'Thème : sombre' };

export function applyTheme(cfg) {
  const d = document.documentElement;
  d.dataset.theme = cfg.theme;
  d.dataset.accent = cfg.accent;
  d.dataset.density = cfg.density;
  d.dataset.motion = cfg.animations ? 'on' : 'off';
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      theme: cfg.theme, accent: cfg.accent, density: cfg.density, motion: d.dataset.motion,
    }));
  } catch { /* stockage indisponible */ }
  document.dispatchEvent(new CustomEvent('themechange', { detail: cfg }));
}

export async function initTheme() {
  applyTheme(await getConfig());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.some((k) => k in changes)) getConfig().then(applyTheme);
  });
}

export async function cycleTheme() {
  const { theme } = await getConfig();
  await setConfig({ theme: THEME_NEXT[theme] || 'system' });
}

export function bindThemeButton(btn) {
  const update = () => {
    const theme = document.documentElement.dataset.theme || 'system';
    btn.innerHTML = icon(THEME_ICON[theme]);
    btn.title = `${THEME_LABEL[theme]} (cliquer pour changer)`;
  };
  update();
  document.addEventListener('themechange', update);
  btn.addEventListener('click', cycleTheme);
}
