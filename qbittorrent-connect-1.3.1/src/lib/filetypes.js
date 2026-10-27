// Familles de fichiers : icône et libellé selon l'extension.

const FILE_TYPES = [
  ['video', /\.(mkv|mp4|avi|mov|wmv|m4v|webm|ts|m2ts|mpe?g|flv|vob)$/i],
  ['audio', /\.(mp3|flac|aac|ogg|opus|wav|m4a|alac|ape|wma|dsf)$/i],
  ['image', /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|avif)$/i],
  ['archive', /\.(zip|rar|7z|tar|gz|bz2|xz|zst|r\d\d)$/i],
  ['subtitle', /\.(srt|ass|ssa|sub|idx|vtt|sup)$/i],
  ['disc', /\.(iso|img|bin|cue|dmg|nrg)$/i],
  ['text', /\.(nfo|txt|md|pdf|epub|mobi|azw3|cbz|cbr|docx?)$/i],
];

export const TYPE_ICON = {
  video: 'film', audio: 'music', image: 'image', archive: 'archive',
  subtitle: 'captions', disc: 'disc', text: 'fileText', file: 'file',
};

export const TYPE_LABEL = {
  video: 'Vidéo', audio: 'Audio', image: 'Image', archive: 'Archive',
  subtitle: 'Sous-titres', disc: 'Image disque', text: 'Document', file: 'Fichier',
};

export function fileType(name) {
  for (const [type, re] of FILE_TYPES) if (re.test(name)) return type;
  return 'file';
}

// « Vidéo MKV », « Fichier DAT », « Fichier »
export function typeLabel(name) {
  const ext = /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toUpperCase();
  const label = TYPE_LABEL[fileType(name)];
  return ext ? `${label} ${ext}` : label;
}
