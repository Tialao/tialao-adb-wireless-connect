# Journal des modifications

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet respecte le [versionnage sémantique](https://semver.org/lang/fr/).

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
