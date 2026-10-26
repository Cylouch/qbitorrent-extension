<p align="center">
  <img src="docs/images/banniere-1400x560.png" alt="Torrent Connect" width="100%">
</p>

# Torrent Connect

Extension Chrome qui envoie tes `.torrent` et liens magnet à ton client torrent, sans quitter le navigateur. Elle range tes séries et tes films dans les bons dossiers et te prévient quand un nouvel épisode sort.

Compatible **qBittorrent, Transmission, Deluge, rTorrent / ruTorrent, µTorrent, Synology Download Station, Flood et aria2**, que le client tourne sur un NAS, un serveur maison ou un autre PC.

> Extension indépendante, sans lien avec les éditeurs des logiciels cités.

## Sommaire

1. [Installation](#installation)
2. [Connecter ton client torrent](#connecter-ton-client-torrent)
3. [Ajouter un torrent](#ajouter-un-torrent)
4. [La popup](#la-popup)
5. [Ranger automatiquement séries et films](#ranger-automatiquement-séries-et-films)
6. [Alertes de sorties](#alertes-de-sorties)
7. [Personnaliser](#personnaliser)
8. [Synchronisation et sauvegarde](#synchronisation-et-sauvegarde)
9. [En cas de problème](#en-cas-de-problème)
10. [Confidentialité](#confidentialité)

---

## Installation

1. Télécharge ce dépôt : bouton vert **Code** › **Download ZIP**, puis décompresse-le (ou `git clone`).
2. Dans Chrome, ouvre `chrome://extensions`.
3. Active le **Mode développeur** (interrupteur en haut à droite).
4. Clique sur **Charger l'extension non empaquetée** et choisis le dossier qui contient `manifest.json`.
5. Épingle l'extension : icône puzzle 🧩 de la barre d'outils › punaise à côté de **Torrent Connect**.
6. **Recommandé** : sur la fiche de l'extension dans `chrome://extensions`, active **« Autoriser l'accès aux URL de fichier »**. L'extension pourra lire directement le `.torrent` téléchargé, ce qui marche même avec les liens à usage unique des trackers privés.

La page des paramètres s'ouvre toute seule au premier lancement.

> Raccourci clavier : **Alt + Maj + T** ouvre la popup.

## Connecter ton client torrent

Dans **Paramètres › Client torrent** :

1. Choisis ton **logiciel** dans la liste.
2. Saisis l'**adresse de l'interface web**, par exemple `http://192.168.1.20:8080`.
3. Saisis ton **nom d'utilisateur** et ton **mot de passe** (ou le jeton pour aria2).
4. Clique sur **Enregistrer et tester**. La pastille en bas à gauche passe au vert avec la version du client.

| Client | Ce qu'il faut activer | Adresse habituelle |
|---|---|---|
| qBittorrent 4.1 ou plus | Outils › Options › Interface web | `http://IP:8080` |
| Transmission 2.x à 4.x (et Vuze / BiglyBT) | Accès à distance (plugin Web Remote pour Vuze) | `http://IP:9091` |
| Deluge 1.3 ou 2.x | Interface web `deluge-web` | `http://IP:8112` |
| rTorrent / ruTorrent | XML-RPC : `/RPC2`, ou `/plugins/rpc/rpc.php` avec ruTorrent | `http://IP` |
| µTorrent / BitTorrent | Préférences › Interface web | `http://IP:8080` |
| Synology Download Station | Adresse de DSM ; les emplacements commencent par un dossier partagé (`video/Séries`) | `https://IP:5001` |
| Flood | Interface Flood (jesec/flood) | `http://IP:3000` |
| aria2 | `aria2c --enable-rpc` ; le jeton correspond à `--rpc-secret` | `http://IP:6800` |

Les options proposées s'adaptent au client : par exemple, catégories, étiquettes et explorateur de dossiers n'existent pas partout.

## Ajouter un torrent

<p align="center">
  <img src="docs/images/1-fenetre-ajout-sombre.png" alt="Fenêtre d'ajout d'un torrent" width="90%">
</p>

La fenêtre d'ajout s'ouvre :

- **dès qu'un `.torrent` finit de se télécharger** dans Chrome ;
- **quand tu cliques sur un lien `magnet:`** (**Alt + clic** garde le comportement normal du navigateur) ;
- par un **clic droit sur un lien › « Envoyer au client torrent »** ;
- depuis la popup : **Fichier .torrent**, ou en collant un lien magnet ou une URL.

Elle reprend les options de l'interface web de ton client :

| Bloc | À quoi il sert |
|---|---|
| **Destination** | Emplacement d'enregistrement, avec l'espace libre du disque. Si le [rangement automatique](#ranger-automatiquement-séries-et-films) reconnaît une série ou un film, l'emplacement est déjà rempli (**Annuler** revient au précédent). **Parcourir** ouvre l'explorateur des dossiers du serveur, façon Windows : lecteurs, espace libre, accès rapide (emplacement par défaut, catégories, emplacements récents), création d'un nouveau dossier. Option pour un dossier des téléchargements incomplets. |
| **Organisation** | Renommer le torrent, choisir une catégorie (case **Par défaut** pour la retenir), ajouter des étiquettes. Une catégorie ou une étiquette qui n'existe pas encore est créée sur le serveur. |
| **Options** | Démarrer tout de suite, mettre en haut de la file, téléchargement séquentiel (pour regarder une vidéo pendant le téléchargement), premiers et derniers morceaux d'abord, sauter la vérification, condition d'arrêt, agencement du contenu. |
| **Limites de vitesse** | Réception et envoi, en Kio/s. Vide = illimité. |
| **Informations** | Hash, trackers, date de création, commentaire. |
| **Fichiers** | Coche ou décoche des fichiers ou des dossiers entiers, choisis leur priorité, filtre la liste. La barre du bas montre la taille sélectionnée. |

Valide avec **Ajouter**, ou **Ctrl + Entrée**. L'extension te prévient si le torrent est déjà dans ton client.

> Si tu décoches des fichiers, le torrent est ajouté à l'arrêt, les priorités sont appliquées, puis il démarre : rien de ce que tu ne veux pas n'est téléchargé.
>
> Pour un lien magnet, la liste des fichiers n'est pas connue à l'avance. Choisis la condition d'arrêt **« Métadonnées reçues »** si tu veux choisir les fichiers ensuite dans l'interface web.

**Ajout direct** : dans **Paramètres › Ajout de torrents**, le mode « ajout direct » envoie le torrent immédiatement avec tes réglages par défaut, sans ouvrir de fenêtre.

## La popup

<p align="center">
  <img src="docs/images/2-popup.png" alt="Popup de l'extension" width="90%">
</p>

Un clic sur l'icône de l'extension ouvre la popup :

- **Vitesses en direct** de réception et d'envoi, avec mini-graphiques ;
- **Espace libre** sur le disque du serveur ;
- **Liste des torrents** filtrable (Tous, En cours, Terminés, Arrêtés) avec recherche, et bouton démarrer / arrêter au survol ;
- bascule des **limites de vitesse alternatives** (icône compteur) ;
- champ pour **coller un lien magnet ou une URL** ;
- onglet **Sorties** : nouveaux épisodes repérés et prochaines diffusions des séries que tu suis ;
- boutons **Fichier .torrent** et **Interface web**.

Nombre de torrents affichés, fréquence de rafraîchissement et onglet par défaut se règlent dans **Paramètres › Popup**.

## Ranger automatiquement séries et films

Dans **Paramètres › Rangement auto**, indique le **dossier des séries** et le **dossier des films** sur le serveur, puis active **Ranger automatiquement**.

- `Tulsa.King.S04E02.1080p…` va tout seul dans **Séries › Tulsa King › Saison 4**. L'extension reconnaît « S04E02 », « Saison 4 », « 4x02 »…
- Elle retrouve le dossier existant même si son nom diffère un peu, et reprend le style de tes dossiers de saison (« Saison 4 », « Season 04 », « S04 »…).
- Les films, reconnus grâce à l'année et à la qualité, vont dans le dossier des films, un dossier par film si tu le souhaites : `Dune Part Two (2024)`.
- Une catégorie peut être appliquée automatiquement aux séries et aux films.

Le bloc **Essayer** te montre où un nom de torrent serait rangé, avant de télécharger quoi que ce soit.

## Alertes de sorties

Dans **Paramètres › Sources et alertes** :

1. Ajoute le **flux RSS** de ton tracker ou de ton indexeur.
2. Facultatif : ajoute un **indexeur Torznab** (Jackett, Prowlarr…) pour chercher un épisode ou un film précis.
3. Active les **alertes** et choisis la fréquence de vérification. Les flux sont vérifiés en arrière-plan, même sans ouvrir l'extension.

Puis, dans **Séries suivies**, choisis les séries que tu suis, ou **importe ta liste IMDb** (sur IMDb : Liste de suivi › ⋮ › Exporter). Les fiches, affiches et dates des prochains épisodes viennent de TVmaze.

Dès qu'un nouvel épisode sort, une **bannière apparaît en haut de la page que tu consultes**, avec **Voir le torrent** et **Télécharger**. Pour chaque série, tu peux filtrer la qualité et la langue, ou activer le téléchargement automatique.

Le **profil de qualité** (Paramètres › Profil de qualité) décide quelle version prendre quand il y en a plusieurs : résolution, sources préférées, audio 5.1 ou stéréo, versions « Compact » plus légères. Les **films suivis** sont téléchargés (ou proposés) dès leur sortie dans ce profil, puis rangés dans ton dossier des films.

## Personnaliser

<p align="center">
  <img src="docs/images/4-themes.png" alt="Thèmes clair et sombre" width="90%">
</p>

Dans **Paramètres › Apparence** :

- thème **clair, sombre ou automatique** (suit Windows) ; le bouton soleil / lune en haut de la popup et de la fenêtre d'ajout change le thème en un clic ;
- **6 couleurs d'accent** : bleu, violet, émeraude, ambre, rose, cyan ;
- affichage **confortable ou compact**, animations activables.

<p align="center">
  <img src="docs/images/5-parametres.png" alt="Page des paramètres" width="90%">
</p>

<p align="center">
  <img src="docs/images/3-fenetre-ajout-claire.png" alt="Fenêtre d'ajout en thème clair" width="90%">
  <br><em>La fenêtre d'ajout en thème clair, accent violet.</em>
</p>

Autres réglages utiles :

- **Ajout de torrents** : fenêtre ou ajout direct, catégorie par défaut, réutiliser le dernier emplacement, taille de la fenêtre, fermeture après l'ajout, notifications Windows.
- **Interception** : `.torrent` téléchargés, liens magnet, suppression du `.torrent` local une fois envoyé.

## Synchronisation et sauvegarde

Dans **Paramètres › Synchronisation** :

- **Synchroniser avec mon compte Google** : tes réglages, séries et films suivis te suivent sur tous tes PC (connecte-toi au même compte Google dans Chrome). Les mots de passe, clés API et flux ne sont inclus que si tu le demandes.
- **Exporter / Importer** une sauvegarde : un fichier à garder, ou à importer dans un autre navigateur (Edge, Brave…).

## En cas de problème

- **Erreur 401** au test de connexion (qBittorrent) : l'extension réécrit déjà les en-têtes `Origin` / `Referer`, donc la protection CSRF peut rester activée. Si l'erreur persiste, décoche « Activer la protection contre la falsification de requêtes intersites (CSRF) » dans les options de l'interface web de qBittorrent.
- **Erreur 403** : après trop d'échecs de connexion, qBittorrent bannit l'IP pendant un moment. Attends, puis vérifie ton mot de passe.
- **Serveur en HTTPS avec un certificat auto-signé** : ouvre d'abord son adresse dans Chrome et accepte le certificat.
- **Le `.torrent` d'un tracker privé n'est pas lu** : active « Autoriser l'accès aux URL de fichier » (voir [Installation](#installation)). Sans cette option, l'extension retélécharge le fichier depuis le site avec ta session, ce qui échoue avec les liens à usage unique.
- **L'explorateur de dossiers est vide** : il dépend du client (qBittorrent 5 ou plus récent, ou Flood). Avec les autres, tape le chemin directement.

## Confidentialité

L'extension communique uniquement avec ton client torrent, tes flux RSS et indexeurs, le site d'où provient un `.torrent` et l'API publique de TVmaze. Aucune donnée n'est envoyée au développeur ni à des tiers. Tes identifiants restent dans ton navigateur (`chrome.storage.local`), sauf si tu choisis de les synchroniser avec ton compte Google.
