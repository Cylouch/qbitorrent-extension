// Bannière « nouvel épisode disponible » affichée en haut des pages web.
// Isolée dans un Shadow DOM : le site ne peut ni la casser ni être affecté.
(() => {
  if (window.top !== window) return;

  const ACCENTS = { blue: '#3b82f6', violet: '#8b5cf6', emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e', cyan: '#06b6d4' };
  const QUALITY = { '2160p': '4K', '1080p': '1080p', '720p': '720p', sd: 'SD' };
  const LANG = { multi: 'MULTi', vf: 'VF', vostfr: 'VOSTFR' };
  const AUTO_CLOSE = 30000;

  let shadow = null;
  let stack = null;
  let theme = { dark: true, accent: ACCENTS.blue };

  chrome.storage.local.get({ theme: 'system', accent: 'blue' }, (c) => {
    const dark = c.theme === 'dark' || (c.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    theme = { dark, accent: ACCENTS[c.accent] || ACCENTS.blue };
  });

  const CSS = `
    :host { all: initial; }
    .stack { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
      display: flex; flex-direction: column; gap: 10px; width: min(520px, calc(100vw - 24px));
      font: 400 13.5px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; }
    .card { --bg: #16191f; --fg: #e8ebf1; --muted: #a2aabb; --border: #2b313c; --soft: rgba(255,255,255,.06);
      position: relative; display: flex; gap: 14px; padding: 14px 16px 14px 14px; overflow: hidden;
      background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 16px;
      box-shadow: 0 24px 60px -12px rgba(0,0,0,.55), 0 0 0 1px rgba(0,0,0,.04);
      animation: in .35s cubic-bezier(.2,.8,.2,1); }
    .card.light { --bg: #ffffff; --fg: #121620; --muted: #4b5467; --border: #e3e7ee; --soft: rgba(20,30,50,.05);
      box-shadow: 0 24px 60px -16px rgba(15,23,42,.35), 0 0 0 1px rgba(15,23,42,.03); }
    .card.out { animation: out .25s ease forwards; }
    .poster { width: 58px; height: 84px; flex: none; border-radius: 9px; object-fit: cover; background: var(--soft); }
    .ph { width: 58px; height: 84px; flex: none; border-radius: 9px; display: grid; place-items: center;
      background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-size: 26px; }
    .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .kicker { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; color: var(--accent); }
    .kicker .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent);
      box-shadow: 0 0 0 0 var(--accent); animation: pulse 1.6s infinite; }
    .title { font-size: 16px; font-weight: 700; letter-spacing: -.01em; padding-right: 20px; }
    .code { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 700;
      color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); vertical-align: 2px; }
    .release { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chips { display: flex; gap: 5px; margin-top: 4px; flex-wrap: wrap; }
    .chip { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--soft); color: var(--muted); }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    button { font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 9px; height: 32px; padding: 0 14px; }
    .ghost { background: var(--soft); color: var(--fg); border: 1px solid var(--border); }
    .ghost:hover { border-color: var(--muted); }
    .primary { background: var(--accent); color: #fff; border: 0; box-shadow: 0 6px 16px -6px var(--accent); }
    .primary:hover { filter: brightness(1.08); }
    .primary[disabled] { opacity: .8; cursor: default; }
    .close { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px;
      background: transparent; color: var(--muted); font-size: 18px; line-height: 1; }
    .close:hover { background: var(--soft); color: var(--fg); }
    .timer { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--accent); opacity: .7;
      animation: timer linear forwards; }
    .card:hover .timer { animation-play-state: paused; }
    .more { align-self: center; padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 600;
      background: rgba(22,25,31,.92); color: #e8ebf1; box-shadow: 0 10px 30px -10px rgba(0,0,0,.5); }
    @keyframes in { from { opacity: 0; transform: translateY(-16px) scale(.97); } }
    @keyframes out { to { opacity: 0; transform: translateY(-12px) scale(.97); } }
    @keyframes timer { from { width: 100%; } to { width: 0; } }
    @keyframes pulse { 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
    @media (prefers-reduced-motion: reduce) { .card, .timer { animation: none; } }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensure() {
    if (shadow) return;
    const host = document.createElement('torrent-connect-alerts');
    host.style.all = 'initial';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    stack = el('div', 'stack');
    shadow.append(style, stack);
    (document.body || document.documentElement).append(host);
  }

  const send = (type, id) => {
    try { return chrome.runtime.sendMessage({ type, id }); } catch { return Promise.resolve(); }
  };

  function remove(card) {
    if (!card.isConnected) return;
    card.classList.add('out');
    setTimeout(() => card.remove(), 260);
  }

  function formatSize(b) {
    if (!b) return '';
    const u = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b < 10 ? 2 : 1)} ${u[i]}`;
  }

  function card(a) {
    const c = el('div', `card${theme.dark ? '' : ' light'}`);
    c.style.setProperty('--accent', theme.accent);
    const icon = a.kind === 'movie' ? '🎬' : '📺';

    if (a.poster) {
      const img = el('img', 'poster');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = a.poster;
      img.onerror = () => img.replaceWith(el('div', 'ph', icon));
      c.append(img);
    } else {
      c.append(el('div', 'ph', icon));
    }

    const body = el('div', 'body');
    const kicker = el('div', 'kicker');
    const kind = { episode: 'Nouvel épisode', missing: 'Épisode manquant · tu ne l\'as pas encore', movie: 'Film disponible' }[a.kind] || 'Nouvelle sortie';
    kicker.append(el('span', 'pulse'), document.createTextNode(a.kind === 'missing' ? kind : `${kind} · ${a.feedName || 'Flux RSS'}`));
    const title = el('div', 'title', a.showName);
    if (a.code && a.kind !== 'movie') title.append(el('span', 'code', a.code));
    const release = el('div', 'release', a.title);
    release.title = a.title;
    const chips = el('div', 'chips');
    // « choice » : la version retenue par le profil de qualité (1080p · WEB · EAC3 5.1 · 1,4 Go).
    (a.choice ? [a.choice, LANG[a.lang]] : [QUALITY[a.quality], LANG[a.lang], formatSize(a.size)])
      .concat(a.releases?.length > 1 ? [`${a.releases.length} releases`] : [])
      .filter(Boolean).forEach((t) => chips.append(el('span', 'chip', t)));

    const actions = el('div', 'actions');
    const view = el('button', 'ghost', 'Voir le torrent');
    const dl = el('button', 'primary', a.kind === 'missing' ? '⬇  Oui, télécharger' : '⬇  Télécharger');
    view.addEventListener('click', () => { send('alert-open', a.id); remove(c); });
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      dl.textContent = 'Envoi…';
      const r = await send('alert-download', a.id);
      dl.textContent = r?.ok === false ? 'Échec' : '✓ Envoyé';
      setTimeout(() => remove(c), 1200);
    });
    actions.append(view, dl);
    body.append(kicker, title, release);
    if (chips.childElementCount) body.append(chips);
    body.append(actions);

    const close = el('button', 'close', '×');
    close.title = 'Fermer';
    close.addEventListener('click', () => { send('alert-dismiss', a.id); remove(c); });

    const timer = el('div', 'timer');
    timer.style.animationDuration = `${AUTO_CLOSE}ms`;
    timer.addEventListener('animationend', () => remove(c));

    c.append(body, close, timer);
    return c;
  }

  function show(alerts) {
    if (!alerts?.length) return;
    ensure();
    alerts.slice(0, 3).forEach((a) => stack.append(card(a)));
    if (alerts.length > 3) {
      const more = el('div', 'more', `+ ${alerts.length - 3} autres sorties dans l'extension`);
      stack.append(more);
      setTimeout(() => more.remove(), AUTO_CLOSE);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'show-alerts') return false;
    show(msg.alerts);
    sendResponse({ ok: true });
    return false;
  });

  // Alertes arrivées pendant qu'aucune page ne pouvait les afficher.
  try {
    chrome.runtime.sendMessage({ type: 'alerts-pending' })
      .then((r) => { if (r?.ok && r.value?.length) show(r.value); })
      .catch(() => {});
  } catch { /* extension rechargée */ }
})();
