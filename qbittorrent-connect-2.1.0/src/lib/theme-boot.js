// Chargé en script classique dans le <head> : applique le thème mémorisé avant
// le premier rendu. theme.js prend le relais une fois la page chargée.
(function () {
  var d = document.documentElement;
  var t = {};
  try { t = JSON.parse(localStorage.getItem('qbc-ui') || '{}'); } catch (e) { /* ignoré */ }
  d.dataset.theme = t.theme || 'system';
  d.dataset.accent = t.accent || 'blue';
  d.dataset.density = t.density || 'comfortable';
  d.dataset.motion = t.motion || 'on';
})();
