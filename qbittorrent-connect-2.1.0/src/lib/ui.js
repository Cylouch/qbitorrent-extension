import { icon } from './icons.js';

export const $ = (id) => document.getElementById(id);

// Une affiche introuvable (TVmaze) ne doit pas laisser une image cassée.
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.style.visibility = 'hidden';
}, true);

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Remplace chaque <i data-icon="nom"></i> par l'icône SVG correspondante.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon);
  });
}

let toastTimer;

export function toast(text, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.append(el);
  }
  const ico = { ok: 'checkCircle', error: 'alert' }[kind] || 'info';
  el.innerHTML = `${icon(ico)}<span>${esc(text)}</span>`;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copié dans le presse-papiers', 'ok');
  } catch {
    toast('Impossible de copier', 'error');
  }
}
