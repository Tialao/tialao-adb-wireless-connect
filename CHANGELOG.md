# Journal des modifications

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

## [0.2.1] — 2026-08-31

Version de documentation et d'outillage d'installation : le code de l'extension est
inchangé.

### Corrigé

- **Les scripts d'installation ne trouvaient aucun éditeur là où il y en avait.** Ils ne
  cherchaient les lanceurs que dans le `PATH` ; or `code` n'y est ajouté que si la case
  correspondante a été cochée à l'installation (Windows) ou si *Shell Command: Install
  'code' command in PATH* a été lancé une fois (macOS). Les deux scripts sondent
  désormais aussi les emplacements d'installation standards : `%LOCALAPPDATA%\Programs`
  et `Program Files` sous Windows, `/Applications` sous macOS, `/usr/share`, `/opt` et
  `/snap/bin` sous Linux.
- `scripts/install.ps1` commençait par un BOM UTF-8, ce qui pouvait faire échouer
  l'invocation recommandée `irm … | iex` sur une erreur d'analyse.
- `scripts/install.sh` convertit maintenant le chemin du `.vsix` en chemin absolu :
  `--install-extension` avec un chemin relatif échouait selon le répertoire courant.

### Ajouté

- **Section Installation sur la page de l'extension** (Marketplace / Open VSX), qui n'en
  comportait aucune : la voie *Extensions → `...` → Install from VSIX…*, qui ne dépend ni
  du `PATH` ni d'un terminal, y est décrite en premier.
- README : installation **depuis les sources GitHub** (`git clone` → `npm run package`),
  installation directe depuis le registre
  (`cursor --install-extension tialao.tialao-adb-wireless-connect`), et un tableau
  *Si l'installation échoue* couvrant les messages d'erreur réellement rencontrés.

## [0.2.0] — 2026-08-28

### Ajouté

- **Miroir d'écran** — l'écran du téléphone dans un onglet de l'éditeur, décodé en H.264
  par WebCodecs. Cadre redimensionnable par huit poignées, zoom, ajustement automatique
  à la fenêtre : l'écran tient toujours en entier, sans défilement.
- **Contrôle depuis le miroir** — clic, glisser, molette, clavier (accents compris), et
  une barre d'outils : Retour, Accueil, Applications récentes, notifications, rotation,
  volume, marche/veille.
- Le serveur **scrcpy 3.1** est fourni avec l'extension (Apache 2.0). Son empreinte
  SHA-256 est vérifiée avant chaque envoi sur l'appareil.
- **Barre d'actions** dans le panneau d'association : connecter, déconnecter, écran,
  appareils, code, terminal, serveur.
- **Association par code à six chiffres depuis le panneau**, avec détection automatique
  de l'adresse : le téléphone la publie en mDNS dès l'ouverture de l'écran d'association.
- **Fenêtres centrées** pour la saisie d'adresse, la liste des appareils et la
  confirmation de déconnexion, au lieu des boîtes natives dont la largeur n'est pas
  modifiable par une extension.
- Le **mot de passe d'association est masqué** par défaut, avec un bouton pour l'afficher.
- Commande **Open ADB terminal** : état d'adb et processus adb/scrcpy en cours.

### Corrigé

- **Le miroir ne démarrait qu'une fois sur deux.** L'identifiant de session `scid` était
  tiré sur 32 bits alors que scrcpy le relit avec `Integer.parseInt(s, 16)`, un entier
  signé : toute valeur au-delà de 2^31 - 1 faisait échouer le serveur.
- **L'écran restait noir** malgré un décodage correct : la CSP du panneau miroir omettait
  le nonce sur `style-src`, ce qui bloquait la balise portant la taille du cadre.
- Un appareil connecté sans fil apparaît deux fois dans `adb devices` (entrée TCP et
  entrée mDNS) ; les deux sont désormais regroupées.
- Le sondage mDNS ne laisse plus le processus se terminer prématurément.

### Sécurité

- **Le mot de passe d'association n'apparaît plus dans le journal** — il figurait en clair
  sur la ligne de commande `adb pair`.
- Les commandes déclenchables depuis un webview passent par une **liste blanche**.
- Les adresses et codes venus d'un webview sont **revalidés côté extension** avant d'être
  passés à un processus, au lieu de faire confiance à la validation du client.

## [0.1.0] — 2026-08-28

Première version.

### Ajouté

- **Cœur `tialao-adb-wireless`** — logique autonome, sans dépendance à un éditeur :
  wrapper adb (`execFile` uniquement), découverte mDNS, orchestration de l'association,
  génération du QR, historique des appareils.
- **CLI `tadb`** — `pair-qr`, `pair`, `connect`, `disconnect`, `devices`, `mdns`,
  `tcpip`, `restart`, `history`, `qr`. QR affiché directement dans le terminal.
- **Mode `--json`** — un objet par commande, NDJSON pour les commandes streamantes,
  codes de sortie stables : de quoi piloter l'outil depuis n'importe quel langage.
- **Extension VS Code** — association par QR code dans un webview, association par code
  à 6 chiffres, connexion et déconnexion par QuickPick, mode TCP/IP historique,
  redémarrage du serveur adb, liste des appareils, barre d'état et journal détaillé.
- Repli manuel par saisie de l'adresse `ip:port` quand la découverte mDNS ne trouve rien.
- Recherche automatique du binaire adb dans les emplacements standards du SDK Android.

### Notes techniques

- `adb pair` et `adb connect` renvoient le code de sortie 0 même en cas d'échec :
  tous les verdicts proviennent du parsing de leur sortie texte.
- `ADB_MDNS_AUTO_CONNECT` vaut `adb-tls-connect` par défaut, donc adb se connecte de
  lui-même aux appareils découverts. L'association surveille en parallèle le mDNS et
  `adb devices`, et n'exécute `adb connect` que s'il est réellement nécessaire.
- Le port de connexion change à chaque redémarrage du téléphone : il n'est jamais
  réutilisé depuis l'historique, il est redécouvert en mDNS.
