# qBittorrent Connect

Extension Chrome (Manifest V3) qui envoie tes torrents directement vers ton serveur qBittorrent, avec une fenêtre d'ajout qui reprend les options de l'interface web : emplacement, catégorie, étiquettes, renommage, sélection et priorité des fichiers, limites de vitesse, etc.

## Ce qu'elle fait

- **Fichier .torrent téléchargé** : dès qu'un `.torrent` finit de se télécharger, la fenêtre d'ajout s'ouvre avec la liste des fichiers.
- **Lien magnet** : un clic sur un lien `magnet:` ouvre la fenêtre d'ajout au lieu de lancer un client local (**Alt+clic** garde le comportement normal).
- **Clic droit sur un lien → « Ajouter à qBittorrent »**.
- **Bouton de l'extension** : vitesses en direct avec mini-graphes, espace disque libre, liste des torrents filtrable (en cours, terminés, arrêtés) avec recherche et bouton démarrer/arrêter, bascule des limites de vitesse alternatives, champ pour coller un lien magnet ou une URL.
- **Ajout direct (optionnel)** : envoie le torrent immédiatement avec ta catégorie par défaut, sans ouvrir de fenêtre.

## Personnalisation

Dans les paramètres (icône ⚙ ou clic droit sur l'extension → Options) :

- **Apparence** : thème clair, sombre ou système ; 6 couleurs d'accent ; densité confortable ou compacte ; animations activables. Le bouton soleil/lune en haut de la popup et de la fenêtre d'ajout change le thème en un clic.
- **Ajout de torrents** : fenêtre ou ajout direct, catégorie par défaut, réutilisation du dernier emplacement, taille de la fenêtre, fermeture automatique, notifications.
- **Interception** : `.torrent`, liens magnet, nettoyage du dossier Téléchargements.
- **Popup** : nombre de torrents affichés, fréquence de rafraîchissement, onglet par défaut.

## Installation

1. Ouvre `chrome://extensions`.
2. Active le **Mode développeur** (en haut à droite).
3. Clique sur **Charger l'extension non empaquetée** et choisis le dossier `qbittorrent-connect`.
4. La page de paramètres s'ouvre : saisis l'adresse de l'interface web (par ex. `http://192.168.1.20:8080`), ton identifiant et ton mot de passe, puis **Enregistrer et tester**.
5. Recommandé : sur la fiche de l'extension dans `chrome://extensions`, active **« Autoriser l'accès aux URL de fichier »**. L'extension pourra alors lire directement le `.torrent` téléchargé, ce qui marche même avec les liens à usage unique des trackers privés. Sans cette option, elle retélécharge le fichier depuis le site avec tes cookies.

## Côté qBittorrent

- L'interface web doit être activée (Outils → Options → Interface web).
- L'extension réécrit les en-têtes `Origin`/`Referer` des requêtes envoyées à l'API, donc la protection CSRF peut rester activée. Si le test de connexion renvoie quand même une erreur 401, essaie de décocher « Activer la protection contre la falsification de requêtes intersites (CSRF) » dans qBittorrent.
- Si ton serveur est en HTTPS avec un certificat auto-signé, ouvre d'abord son adresse dans Chrome et accepte le certificat.
- Après trop d'échecs de connexion, qBittorrent bannit l'IP pendant un moment (erreur 403).

## Bon à savoir

- Si tu décoches des fichiers, le torrent est ajouté à l'arrêt, les priorités sont appliquées, puis il est démarré (si « Démarrer le torrent » est coché). Ça évite de télécharger des fichiers que tu ne veux pas.
- Une catégorie ou une étiquette qui n'existe pas encore est créée sur le serveur.
- « Définir comme catégorie par défaut » est mémorisé par l'extension ; les 10 derniers emplacements utilisés sont proposés via le bouton ▾.
- Pour un lien magnet, la liste des fichiers n'est pas connue à l'avance. Choisis la condition d'arrêt « Métadonnées reçues » si tu veux sélectionner les fichiers ensuite dans l'interface web.
- Compatible avec qBittorrent 4.x et 5.x.
- Les identifiants sont stockés en clair dans `chrome.storage.local`, uniquement dans ce navigateur.

## Structure

```
manifest.json
icons/                  icônes 16/32/48/128
src/background.js       détection des téléchargements, menu contextuel, ouverture de la fenêtre
src/content/magnet.js   interception des liens magnet
src/add/                fenêtre d'ajout de torrent
src/popup/              popup du bouton de l'extension
src/options/            page de paramètres
src/lib/qbt.js          client de l'API Web qBittorrent
src/lib/torrent.js      lecture des .torrent (bencode) et des liens magnet
src/lib/config.js       réglages et règle de réécriture des en-têtes
src/lib/theme.js        thèmes clair/sombre, accent, densité
src/lib/icons.js        jeu d'icônes SVG
src/common.css          système de design partagé
```
