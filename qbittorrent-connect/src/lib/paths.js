// Chemins côté serveur : Windows (B:\Films, \\nas\partage) ou Unix (/mnt/films).

export const isWindowsPath = (p) => /^[a-zA-Z]:/.test(p || '') || (p || '').includes('\\');

export const pathSep = (p) => (isWindowsPath(p) ? '\\' : '/');

const isAbsolute = (p) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p || '');

// Séparateurs homogènes, lettre de lecteur en majuscule, sans « \ » final
// (sauf à la racine d'un lecteur : « B:\ »).
export function normalizePath(p) {
  let s = (p || '').trim();
  if (!s) return '';
  if (isWindowsPath(s)) {
    const unc = /^[\\/]{2}[^\\/]/.test(s);
    s = s.replace(/[\\/]+/g, '\\');
    if (unc) s = `\\${s}`;
    if (/^[a-zA-Z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
    if (/^[A-Z]:\\?$/.test(s)) return `${s.slice(0, 2)}\\`;
    return s.replace(/\\+$/, '');
  }
  s = s.replace(/\/+/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

export function joinPath(base, name) {
  if (!base) return name;
  const sep = pathSep(base);
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

// Chemin relatif (catégorie sans chemin absolu) : rattaché à l'emplacement par défaut.
export function resolvePath(base, p) {
  if (!p) return normalizePath(base);
  return normalizePath(isAbsolute(p) ? p : joinPath(base, p));
}

export function baseName(p) {
  return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

// Racine du chemin : « B:\ », « \\nas\partage », point de montage Unix ou « / ».
export function rootOf(p) {
  const s = normalizePath(p);
  let m = /^([A-Z]):/.exec(s);
  if (m) return `${m[1]}:\\`;
  m = /^\\\\[^\\]+\\[^\\]+/.exec(s);
  if (m) return m[0];
  if (s.startsWith('/')) {
    m = /^\/(?:mnt|media|run\/media\/[^/]+|Volumes)\/[^/]+/.exec(s);
    return m ? m[0] : '/';
  }
  return '';
}

// Clé de comparaison : Windows ne tient pas compte de la casse.
export const pathKey = (p) => {
  const s = normalizePath(p);
  return isWindowsPath(s) ? s.toLowerCase() : s;
};

export const samePath = (a, b) => Boolean(a) && Boolean(b) && pathKey(a) === pathKey(b);

export function isInside(path, root) {
  const p = pathKey(path);
  const r = pathKey(root);
  if (!p || !r) return false;
  if (p === r) return true;
  return p.startsWith(/[\\/]$/.test(r) ? r : `${r}${pathSep(r)}`);
}

// Dossier parent, ou null à la racine.
export function parentPath(p) {
  const s = normalizePath(p);
  if (!s || s === '/' || /^[A-Z]:\\$/.test(s) || /^\\\\[^\\]+\\[^\\]+$/.test(s)) return null;
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return null;
  const parent = s.slice(0, i);
  if (/^[A-Z]:$/.test(parent)) return `${parent}\\`;
  return parent || '/';
}

// Morceaux du fil d'Ariane : [{ label, path }], la racine en premier.
export function crumbs(p) {
  const s = normalizePath(p);
  if (!s) return [];
  if (s.startsWith('/')) {
    let acc = '';
    return [{ label: '/', path: '/' }, ...s.split('/').filter(Boolean).map((part) => {
      acc += `/${part}`;
      return { label: part, path: acc };
    })];
  }
  const root = rootOf(s);
  if (!root) return [{ label: s, path: s }];
  const out = [{ label: root, path: root }];
  let acc = root;
  for (const part of s.slice(root.length).split('\\').filter(Boolean)) {
    acc = joinPath(acc, part);
    out.push({ label: part, path: acc });
  }
  return out;
}

// Nom de dossier valide sous Windows comme sous Linux.
export function safeFolderName(name) {
  return (name || '')
    .replace(/:/g, ' -')
    .replace(/[<>"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}
