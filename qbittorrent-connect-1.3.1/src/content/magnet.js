// Intercepte les clics sur les liens magnet et les envoie à la fenêtre d'ajout.
// Alt+clic garde le comportement normal du navigateur.
(() => {
  let enabled = false;

  const refresh = () => {
    chrome.storage.local.get({ interceptMagnets: true, serverUrl: '' }, (c) => {
      enabled = Boolean(c.interceptMagnets && c.serverUrl);
    });
  };
  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ('interceptMagnets' in changes || 'serverUrl' in changes)) refresh();
  });

  document.addEventListener('click', (e) => {
    if (!enabled || e.button !== 0 || e.altKey) return;
    const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!link || !/^magnet:\?/i.test(link.href)) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      chrome.runtime.sendMessage({ type: 'magnet', url: link.href });
    } catch {
      // Extension rechargée : on laisse le navigateur gérer le lien.
      location.href = link.href;
    }
  }, true);

  // Réveille le service worker s'il n'a pas tourné depuis le chargement de
  // l'extension, sinon Chrome ne lui signale pas les .torrent téléchargés.
  // Accès refusé à storage.session = il ne l'a pas encore ouvert aux pages.
  if (window === window.top) {
    chrome.storage.session.get('awake').catch(() => ({})).then(({ awake }) => {
      if (!awake) chrome.runtime.sendMessage({ type: 'wake' }).catch(() => {});
    });
  }
})();
