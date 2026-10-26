# qBittorrent Connect

Extension Chrome (Manifest V3) qui envoie tes torrents directement vers ton serveur qBittorrent, avec une fenêtre d'ajout qui reprend les options de l'interface web : emplacement, catégorie, étiquettes, renommage, sélection et priorité des fichiers, limites de vitesse, etc.

## Ce qu'elle fait

- **Fichier .torrent téléchargé** : dès qu'un `.torrent` finit de se télécharger, la fenêtre d'ajout s'ouvre avec la liste des fichiers.
- **Lien magnet** : un clic sur un lien `magnet:` ouvre la fenêtre d'ajout au lieu de lancer un client local (**Alt+clic** garde le comportement normal).
- **Clic droit sur un lien → « Ajouter à qBittorrent »**.
- **Bouton de l'extension** : vitesses en direct avec mini-graphes, espace disque libre, liste des torrents filtrable (en cours, terminés, arrêtés) avec recherche et bouton démarrer/arrêter, bascule des limites de vitesse alternatives, champ pour coller un lien magnet ou une URL.
- **Disques du serveur** : un clic sur l'espace libre dans la popup déplie la liste de tous les disques branchés sur le serveur, avec l'espace libre, la place prise par tes torrents et ce qui reste à télécharger. Un disque presque plein passe en orange puis en rouge.
- **Explorateur du serveur** : un gestionnaire de fichiers façon Windows (bouton dossier de la popup, ou **Parcourir** dans la fenêtre d'ajout). Disques, accès rapide (emplacement par défaut, catégories, emplacements récents), fil d'Ariane cliquable ou chemin à taper, dossiers et fichiers avec taille et date, tri par colonne, recherche, vue détails ou grandes icônes, raccourcis clavier (Retour arrière, Alt+←/→, F5, Ctrl+L, flèches, Entrée). Dans la fenêtre d'ajout, **Nouveau dossier** prépare un dossier que qBittorrent créera au premier téléchargement, et l'espace libre du disque choisi est comparé à la taille du torrent.
- **Nouveautés des indexeurs** : une page (bouton ✦ de la popup, ou **Nouveautés** dans l'explorateur) qui affiche les 15 dernières sorties de chaque indexeur ajouté, films et séries en priorité. Un clic sur une sortie ouvre sa page sur le site ; le bouton ⬇ l'envoie à qBittorrent (fenêtre d'ajout ou ajout direct) ; une coche verte signale ce qui est déjà dans qBittorrent. **Vue Affiches** (par défaut) : un mur d'affiches par indexeur, avec le titre lisible, l'année ou l'épisode (« S04E01 »), la définition et la langue ; les listes ont aussi une vignette. L'affiche vient du flux quand il en donne une (Torznab `coverurl`, image de la description…), sinon d'IMDb à partir du titre de la release, titres français compris (« Les Gouttes de Dieu » → *Drops of God*) ; chaque film ou série n'est cherché qu'une fois. Filtres Tout / Films / Séries, recherche, vue Affiches, Listes ou chronologique, 10 à 50 sorties par indexeur. Ce qui est sorti depuis ta dernière visite est marqué **Nouveau**. La page s'actualise à l'ouverture (si la dernière lecture date de plus de 5 minutes) puis toutes les 10 minutes tant qu'elle reste ouverte.
- **Ajout direct (optionnel)** : envoie le torrent immédiatement avec ta catégorie par défaut, sans ouvrir de fenêtre.

## Personnalisation

Dans les paramètres (icône ⚙ ou clic droit sur l'extension → Options) :

- **Apparence** : thème clair, sombre ou système ; 6 couleurs d'accent ; densité confortable ou compacte ; animations activables. Le bouton soleil/lune en haut de la popup et de la fenêtre d'ajout change le thème en un clic.
- **Ajout de torrents** : fenêtre ou ajout direct, catégorie par défaut, réutilisation du dernier emplacement, taille de la fenêtre, fermeture automatique, notifications.
- **Interception** : `.torrent`, liens magnet, nettoyage du dossier Téléchargements.
- **Popup** : nombre de torrents affichés, fréquence de rafraîchissement, onglet par défaut ; recherche des affiches sur IMDb pour la page Nouveautés (désactivable : le titre des sorties n'est alors plus envoyé à IMDb).

## Installation

1. Ouvre `chrome://extensions`.
2. Active le **Mode développeur** (en haut à droite).
3. Clique sur **Charger l'extension non empaquetée** et choisis le dossier `qbittorrent-connect`.
4. La page de paramètres s'ouvre : saisis l'adresse de l'interface web (par ex. `http://192.168.1.20:8080`), ton identifiant et ton mot de passe, puis **Enregistrer et tester**.
5. Recommandé : sur la fiche de l'extension dans `chrome://extensions`, active **« Autoriser l'accès aux URL de fichier »**. L'extension pourra alors lire directement le `.torrent` téléchargé, ce qui marche même avec les liens à usage unique des trackers privés. Sans cette option, elle retélécharge le fichier depuis le site avec tes cookies.

## Ajouter un indexeur

Sur la page Nouveautés, **Ajouter un indexeur** accepte trois sortes d'adresses :

- **Flux RSS** du site (souvent sur la page d'une catégorie ou dans ton profil, avec ta passkey). Prends de préférence le flux d'une catégorie Films ou Séries.
- **Torznab** : C411 (`https://c411.org/api/torznab` + ta clé API), un indexeur Jackett (« Copy Torznab Feed ») ou Prowlarr (`http://serveur:9696/<numéro>/`), avec la clé API. L'extension demande les catégories Films (2000) et Séries (5000).
- **Page d'accueil du site** : l'extension y cherche le flux RSS annoncé et remplace l'adresse par celle du flux.

**Tester** lit le flux et indique combien de films et de séries il contient. « Films et séries » masque le reste (musique, jeux, logiciels…), « Tout le contenu » garde tout. Les sites protégés par Cloudflare ou qui demandent d'être connecté utilisent tes cookies de Chrome : ouvre le site une fois si la lecture échoue.

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
- Compatible avec qBittorrent 4.x et 5.x. L'explorateur demande la 5.0 ou plus (tailles et dates des fichiers : 5.2), l'espace libre de chaque disque la 5.3 ; avant, seul l'espace libre de l'emplacement par défaut est connu.
- qBittorrent ne donne pas la taille totale des disques : l'extension affiche l'espace libre et la place prise par les torrents. Sur un serveur Windows, les lecteurs A: à Z: sont détectés automatiquement (liste gardée 10 minutes, bouton Actualiser pour la refaire). Le crayon sur un disque permet de lui donner un nom (« Films », « Séries »…).
- Les identifiants, clés API et adresses des indexeurs (passkeys comprises) sont stockés en clair dans `chrome.storage.local`, uniquement dans ce navigateur.

## Structure

```
manifest.json
icons/                  icônes 16/32/48/128
src/background.js       détection des téléchargements, menu contextuel, ouverture de la fenêtre
src/content/magnet.js   interception des liens magnet
src/add/                fenêtre d'ajout de torrent
src/popup/              popup du bouton de l'extension
src/files/              page « Explorateur du serveur »
src/feeds/              page « Nouveautés des indexeurs »
src/options/            page de paramètres
src/ui/explorer.js      gestionnaire de fichiers (fenêtre de choix et page complète)
src/lib/qbt.js          client de l'API Web qBittorrent
src/lib/feeds.js        flux RSS, Atom et Torznab, classement films / séries
src/lib/posters.js      affiches : noms de releases, recherche IMDb, cache
src/lib/storage.js      disques du serveur : détection, espace libre, place des torrents
src/lib/paths.js        chemins du serveur (Windows ou Unix)
src/lib/filetypes.js    familles de fichiers (icône, libellé)
src/lib/torrent.js      lecture des .torrent (bencode) et des liens magnet
src/lib/config.js       réglages et règle de réécriture des en-têtes
src/lib/theme.js        thèmes clair/sombre, accent, densité
src/lib/icons.js        jeu d'icônes SVG
src/common.css          système de design partagé
```
