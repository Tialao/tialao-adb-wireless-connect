# TIALAO ADB Wireless Connect

Connecter un smartphone Android en **ADB sans fil** — par QR code ou par code d'association à
6 chiffres — sans ouvrir Android Studio.

C'est exactement ce que fait le « Wireless debugging / Pair device » d'Android Studio, mais
disponible partout : dans VS Code et ses forks via une extension, et dans n'importe quel autre
éditeur ou terminal via le CLI `tadb`.

```
┌─────────────────────────────────────────────────────────────┐
│  packages/core    logique + CLI tadb  (zéro API d'éditeur)  │
│  packages/vscode  extension .vsix     (interface seulement) │
└─────────────────────────────────────────────────────────────┘
```

## Sommaire

- [Ce que fait l'outil](#ce-que-fait-loutil)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Utilisation — extension VS Code](#utilisation--extension-vs-code)
- [Utilisation — CLI `tadb`](#utilisation--cli-tadb)
- [Couverture par éditeur](#couverture-par-éditeur)
- [Réglages](#réglages)
- [Dépannage](#dépannage)
- [Comment ça marche](#comment-ça-marche)
- [Développement](#développement)
- [Publication](#publication)

## Ce que fait l'outil

| Commande (palette : `TIALAO ADB:`) | Effet |
| --- | --- |
| **Pair device with QR code** | Affiche un QR code, détecte le téléphone qui l'a scanné, associe puis connecte — automatiquement |
| **Pair device with pairing code** | Demande l'`ip:port` et le code à 6 chiffres affichés sur le téléphone |
| **Connect to device** | Liste les appareils découverts sur le réseau et ceux déjà associés |
| **Disconnect device** | Déconnecte un appareil Wi-Fi, ou tous |
| **Enable TCP/IP mode** | Pour Android 10 et antérieurs : bascule un appareil USB en TCP/IP, puis s'y connecte |
| **Restart ADB server** | `kill-server` puis `start-server` — le remède au statut `offline` |
| **Show connected devices** | `adb devices -l` mis en forme dans le journal |
| **Mirror device screen** | L'écran du téléphone dans un onglet, redimensionnable et pilotable à la souris et au clavier |
| **Open ADB terminal** | Un terminal montrant l'état d'adb et les processus adb/scrcpy en cours |

Plus : un indicateur dans la barre d'état (rafraîchi toutes les 5 s, cliquable), un journal
« TIALAO ADB » qui consigne chaque commande adb et sa sortie brute, et des messages d'erreur qui
disent quoi faire plutôt que « command failed ».

## Prérequis

1. **Les platform-tools Android** (`adb`). Si `adb` n'est pas dans le `PATH`, l'extension le
   cherche automatiquement dans les emplacements standards :
   `$ANDROID_HOME/platform-tools`, `$ANDROID_SDK_ROOT/platform-tools`,
   `~/Library/Android/sdk/platform-tools`, `%LOCALAPPDATA%\Android\Sdk\platform-tools`,
   `~/Android/Sdk/platform-tools`. Sinon elle propose de renseigner le chemin.
2. **Android 11 ou plus récent** pour l'association sans fil (QR code / code d'association).
   Pour Android 10 et antérieurs, utilisez le mode TCP/IP, qui exige un premier branchement USB.
3. **Le même réseau Wi-Fi** pour l'ordinateur et le téléphone, sans isolation des clients.
4. **Les options pour les développeurs** activées sur le téléphone, avec le **Débogage sans fil**.

## Installation

Le **même** `.vsix` fonctionne sur **tous** les éditeurs de la famille VS Code — VS Code, Cursor,
Windsurf, VSCodium, Trae, Kiro, Positron. Il n'existe pas de paquet par éditeur ni par système
d'exploitation : le paquet publié est `universal`.

### 1. Depuis l'éditeur (le plus simple)

| Éditeur | Registre | Où chercher |
| --- | --- | --- |
| VS Code | Marketplace Visual Studio | **Extensions** → « TIALAO ADB Wireless Connect » |
| Cursor, Windsurf, VSCodium, Trae | [Open VSX](https://open-vsx.org/extension/tialao/tialao-adb-wireless-connect) | **Extensions** → même recherche |

> Certains éditeurs (Cursor, Windsurf) n'interrogent pas Open VSX directement mais un **miroir**
> rafraîchi périodiquement : une version tout juste publiée peut n'y apparaître qu'après un
> délai, voire pas du tout selon l'éditeur. Ce n'est pas un problème d'installation — prenez la
> voie 2, qui installe exactement le même paquet.

### 2. Le `.vsix` par l'interface de l'éditeur — la voie qui ne rate jamais

1. Téléchargez le `.vsix` :
   - depuis [Open VSX](https://open-vsx.org/extension/tialao/tialao-adb-wireless-connect),
     bouton **Download** ;
   - ou depuis la
     [page des versions GitHub](https://github.com/Tialao/tialao-adb-wireless-connect/releases/latest).
2. Dans l'éditeur : **Extensions** (`Ctrl+Shift+X`) → menu **`...`** en haut du panneau →
   **Install from VSIX…** → sélectionnez le fichier téléchargé.
3. Rechargez la fenêtre si l'éditeur le propose.

Cette voie ne dépend ni du `PATH`, ni du nom de la commande, ni d'un terminal. C'est celle à
donner à quelqu'un chez qui « la commande ne passe pas ».

### 3. En ligne de commande

Depuis le dossier où se trouve le `.vsix` téléchargé — **le nom de la commande change selon
l'éditeur**, le fichier non :

```bash
code     --install-extension tialao-adb-wireless-connect.vsix
cursor   --install-extension tialao-adb-wireless-connect.vsix
windsurf --install-extension tialao-adb-wireless-connect.vsix
codium   --install-extension tialao-adb-wireless-connect.vsix
trae     --install-extension tialao-adb-wireless-connect.vsix
```

Sans passer par un fichier, en tirant directement depuis le registre :

```bash
cursor --install-extension tialao.tialao-adb-wireless-connect
```

**Le piège** : ces commandes ne sont dans le `PATH` que si l'éditeur les y a ajoutées. Sous
Windows, cela dépend d'une case cochée à l'installation ; sous macOS, il faut lancer une fois
**Shell Command: Install 'code' command in PATH** depuis la palette. Si le terminal répond
`command not found` ou « n'est pas reconnu », l'éditeur n'est pas en cause : utilisez la voie 2.

### 4. Script d'installation (installe sur tous les éditeurs détectés)

Le script télécharge le `.vsix` de la dernière version publiée, détecte les éditeurs présents sur
la machine et l'installe sur chacun, en ignorant silencieusement les absents. Il cherche les
éditeurs **au-delà du `PATH`**, à leurs emplacements d'installation standards.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Tialao/tialao-adb-wireless-connect/main/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Tialao/tialao-adb-wireless-connect/main/scripts/install.ps1 | iex
```

Pour installer un `.vsix` déjà téléchargé plutôt que la dernière version en ligne :

```bash
./install.sh --vsix ./tialao-adb-wireless-connect.vsix
```

```powershell
.\install.ps1 -VsixPath .\tialao-adb-wireless-connect.vsix
```

### 5. Depuis les sources GitHub (compiler soi-même)

Utile pour installer un correctif avant sa publication, ou pour vérifier soi-même ce que contient
le paquet. Requiert **Node.js ≥ 22.18** (le paquet produit, lui, tourne à partir de Node 20.11).

```bash
git clone https://github.com/Tialao/tialao-adb-wireless-connect.git
cd tialao-adb-wireless-connect
npm install
npm run package       # produit ./tialao-adb-wireless-connect.vsix
```

Puis installez le `.vsix` obtenu, par la voie 2 (interface) ou la voie 3 (ligne de commande) :

```bash
code --install-extension ./tialao-adb-wireless-connect.vsix
```

Pour seulement essayer sans installer : ouvrez le dépôt dans VS Code et lancez **Run Extension**
(`F5`), qui démarre une fenêtre d'hôte de développement.

### 6. CLI seul (sans éditeur)

```bash
npm install -g tialao-adb-wireless
tadb pair-qr
```

### Si l'installation échoue

| Symptôme | Cause | Solution |
| --- | --- | --- |
| `code : command not found`, « Le terme « code » n'est pas reconnu » | Le CLI de l'éditeur n'est pas dans le `PATH` | Voie 2 (interface), ou macOS : palette → *Shell Command: Install 'code' command in PATH* |
| La commande `code` n'existe pas mais l'éditeur est installé | Sur Cursor / Windsurf, la commande s'appelle `cursor` / `windsurf` | Utilisez le nom correspondant à votre éditeur |
| « Unable to read file », « Extension not found » | Chemin relatif résolu depuis un autre dossier | Donnez le chemin **absolu** du `.vsix`, ou placez-vous dans le dossier de téléchargement |
| Le fichier téléchargé porte l'extension `.zip` | Certains navigateurs renomment les archives | Renommez-le en `.vsix` |
| « is not compatible with VS Code *x.y* » | Éditeur antérieur à VS Code 1.85 | Mettez l'éditeur à jour |
| L'extension ne se trouve pas dans le panneau Extensions | L'éditeur interroge un miroir d'Open VSX en retard | Voie 2 |
| Installée, mais aucune commande « TIALAO ADB » | Fenêtre pas rechargée | *Developer: Reload Window*, puis palette → `TIALAO ADB` |

## Utilisation — extension VS Code

### Associer avec un QR code

1. Palette de commandes (`Ctrl+Shift+P`) → **TIALAO ADB: Pair device with QR code**.
2. Sur le téléphone : **Paramètres → Options pour les développeurs → Débogage sans fil →
   Associer l'appareil à l'aide d'un QR code**.
3. Scannez le QR affiché. Le panneau suit l'avancement en direct : *attente du scan →
   association → connexion → connecté*.

Tout est automatique après le scan : détection du téléphone en mDNS, `adb pair`, puis `adb connect`.

### Associer avec un code à 6 chiffres

À utiliser quand la découverte réseau ne fonctionne pas (voir [Dépannage](#dépannage)).
Sur le téléphone : **Débogage sans fil → Associer l'appareil à l'aide d'un code d'association**.
L'écran affiche une adresse `IP:port` et un code — l'extension demande les deux.

### Se reconnecter plus tard

**TIALAO ADB: Connect to device** liste les appareils actuellement visibles sur le réseau ainsi
que ceux déjà associés. Un appareil déjà associé n'a pas besoin d'être ré-associé : il suffit
d'activer le Débogage sans fil sur le téléphone et de le sélectionner.

## Utilisation — CLI `tadb`

```bash
tadb pair-qr                        # QR affiché dans le terminal, association complète
tadb pair 192.168.1.42:41234 123456 # association par code à 6 chiffres
tadb connect                        # reconnecte le dernier appareil (redécouvert en mDNS)
tadb connect 192.168.1.42:37123     # connexion directe
tadb disconnect                     # déconnecte tout
tadb devices                        # appareils vus par adb
tadb mdns --watch                   # services mDNS, en direct
tadb tcpip --port 5555              # mode TCP/IP depuis un appareil USB
tadb restart                        # redémarre le serveur adb
tadb history                        # appareils déjà associés
```

### Mode machine

```bash
tadb devices --json          # un objet JSON, une ligne
tadb pair-qr --json          # NDJSON : un événement par ligne, terminé par {"type":"done"}
tadb mdns --watch --json
```

En mode `--json`, **la sortie standard ne contient que du JSON** — aucune ligne d'affichage ne
s'y mélange. Codes de sortie : `0` succès, `1` échec, `2` erreur d'usage, `3` adb introuvable,
`4` délai dépassé, `5` annulé, `6` mDNS indisponible.

Exemple d'intégration :

```bash
tadb pair-qr --json | while read -r line; do
  echo "$line" | jq -r 'select(.type=="connected") | .device.serial'
done
```

## Miroir d'écran

**TIALAO ADB: Mirror device screen** affiche l'écran du téléphone dans un onglet de
l'éditeur, comme le panneau « Running Devices » d'Android Studio.

- **Redimensionnable** : huit poignées sur les bords et les coins, un zoom, et un bouton
  d'ajustement. Le ratio est toujours préservé et l'écran tient en entier, sans
  défilement. `Ctrl + molette` zoome également.
- **Pilotable** : clic pour toucher, glisser pour balayer, molette pour faire défiler.
  Le clavier écrit directement dans le téléphone, accents compris. Une barre d'outils
  donne Retour, Accueil, Applications récentes, notifications, rotation, volume et
  marche/veille.

Le miroir s'appuie sur le **serveur scrcpy 3.1**, fourni avec l'extension et poussé sur
l'appareil au démarrage de la session. Son empreinte SHA-256 est vérifiée avant chaque
envoi : ce binaire s'exécute sur votre téléphone, il n'est pas pris sur parole. Il est
distribué sous licence Apache 2.0, dont une copie accompagne l'extension.

Trois réglages permettent d'ajuster le compromis netteté/fluidité :
`tialaoAdb.mirrorMaxSize` (défaut 1280), `tialaoAdb.mirrorBitRate` (8 Mbit/s) et
`tialaoAdb.mirrorMaxFps`. Réduire la taille allège l'encodage sans changer la taille
d'affichage, qui reste libre.

> Le miroir demande **Android 11 ou plus récent** et un appareil déjà connecté. Il ne
> fonctionne pas sur un appareil `offline` ou seulement associé.

## Couverture par éditeur

Il n'existe pas de format de plugin universel. Voici ce qui est **réellement** pris en charge.

### Nativement, via le `.vsix`

VS Code, **Cursor**, **Windsurf**, **VSCodium**, **Trae**, **Kiro**, et tout autre fork de
VS Code. Un seul artefact pour tous.

### Via le CLI `tadb`

Tous les autres environnements : **Android Studio et les IDE JetBrains**, **Zed**,
**Sublime Text**, **Neovim**, **Emacs**, **Xcode**, ou simplement un terminal.

> L'extension elle-même **ne tourne pas** sur JetBrains, Zed ou Sublime Text : leurs
> architectures de plugins (JVM, Rust/WASM, Python) sont incompatibles avec le format `.vsix` et
> exigeraient trois portages distincts. Le CLI est la réponse pour ces éditeurs — et comme toute
> la logique vit dans `packages/core`, ces portages pourront être écrits plus tard sans
> réimplémenter quoi que ce soit.

#### Neovim

```lua
-- Association sans fil dans un terminal flottant : <leader>ap
vim.keymap.set('n', '<leader>ap', function()
  vim.cmd('botright split | terminal tadb pair-qr')
  vim.cmd('startinsert')
end, { desc = 'ADB : associer un appareil sans fil' })

-- Liste des appareils dans la ligne de commande
vim.api.nvim_create_user_command('AdbDevices', function()
  print(vim.fn.system('tadb devices'))
end, {})
```

#### IDE JetBrains (Android Studio, IntelliJ IDEA, PyCharm…)

Deux possibilités :

1. **Terminal intégré** (`Alt+F12`) : tapez `tadb pair-qr`. Le QR s'affiche dans le terminal.
2. **Configuration d'exécution réutilisable** : *Run → Edit Configurations… → + → Shell Script*
   - Nom : `ADB : associer sans fil`
   - Script text : `tadb pair-qr`
   - Cochez *Execute in the terminal*
   - Assignez-lui un raccourci dans *Settings → Keymap*.

Une fois l'appareil connecté, il apparaît dans le sélecteur d'appareils d'Android Studio comme
n'importe quel appareil adb.

## Réglages

| Réglage | Défaut | Rôle |
| --- | --- | --- |
| `tialaoAdb.adbPath` | `"adb"` | Chemin vers le binaire adb |
| `tialaoAdb.autoConnectOnStartup` | `false` | Reconnecter le dernier appareil à l'ouverture de la fenêtre |
| `tialaoAdb.discoveryTimeout` | `120` | Timeout de découverte, en secondes |
| `tialaoAdb.showStatusBar` | `true` | Afficher l'appareil dans la barre d'état |
| `tialaoAdb.disableMdnsAutoConnect` | `false` | Empêcher adb de se connecter seul aux appareils découverts (redémarre le serveur adb) |

## Dépannage

Réflexe systématique : **ouvrez le journal**. *Affichage → Sortie → « TIALAO ADB »*. Il contient
chaque commande adb lancée et sa sortie brute.

### « adb est introuvable »

Installez les [platform-tools](https://developer.android.com/tools/releases/platform-tools) et
renseignez `tialaoAdb.adbPath` avec le chemin complet du binaire (`adb.exe` sous Windows).
L'extension propose automatiquement le chemin si elle trouve un adb ailleurs que celui configuré.

### L'appareil apparaît en `offline`

Lancez **TIALAO ADB: Restart ADB server**. Si le problème persiste, débranchez/rebranchez le
câble, ou révoquez les autorisations de débogage USB sur le téléphone
(*Options pour les développeurs → Révoquer les autorisations de débogage USB*) et réautorisez.

Cause fréquente : deux serveurs adb de versions différentes se disputent le port 5037 (par
exemple celui d'Android Studio et celui de `scrcpy`). Utilisez le même binaire partout.

### La découverte mDNS ne trouve rien

C'est le problème le plus courant, en particulier sous Windows. Dans l'ordre :

1. **Le pare-feu.** Au premier lancement, Windows Defender demande d'autoriser `adb.exe`. Si la
   demande a été refusée, la découverte reste **vide indéfiniment, sans jamais afficher
   d'erreur**. Autorisez `adb.exe` dans *Pare-feu Windows Defender → Autoriser une application*.
2. **Le profil réseau.** Le Wi-Fi doit être en profil **Privé**, pas **Public** : le mDNS est
   bloqué sur un réseau public.
3. **Vérifiez le backend** : `adb mdns check` doit répondre quelque chose comme
   `mdns daemon version [Openscreen discovery 0.0.0]`. Sinon :
   `adb kill-server`, puis `ADB_MDNS_OPENSCREEN=1 adb start-server`.
4. **Repli** : utilisez **Pair device with pairing code**, ou le bouton
   *Saisir l'adresse manuellement* du panneau QR. L'association par code ne dépend pas du mDNS.

### Isolation des clients Wi-Fi

Beaucoup de réseaux d'entreprise, d'hôtel et de « box » en mode invité isolent les clients les
uns des autres : aucun trafic direct n'est possible entre l'ordinateur et le téléphone, et
**aucune** méthode d'association sans fil ne peut fonctionner. Utilisez un autre réseau, ou le
partage de connexion du téléphone, ou passez en USB.

### « Ça marchait hier, et là ça ne se connecte plus »

**Le port de connexion change à chaque redémarrage du téléphone.** C'est le comportement normal
d'Android, pas un bug. N'enregistrez pas d'adresse `ip:port` en marque-page : relancez
**Connect to device**, qui redécouvre le port courant en mDNS. L'appareil reste associé, il n'y
a pas besoin de refaire l'association.

### Android 10 ou antérieur

L'association sans fil (QR / code) n'existe pas avant Android 11. Utilisez
**TIALAO ADB: Enable TCP/IP mode** : branchez le téléphone en USB, lancez la commande, puis
débranchez le câble. Attention, ce mode est moins sûr (aucune authentification par paire) et se
désactive au redémarrage du téléphone.

### Le QR code ne se scanne pas

Le QR doit être scanné depuis l'écran **Débogage sans fil → Associer l'appareil à l'aide d'un QR
code** du téléphone, et **non** avec l'application appareil photo. Si le panneau est trop étroit,
élargissez-le. Dans un terminal Windows, si le QR s'affiche en `?`, lancez `chcp 65001`, ou
utilisez `tadb pair-qr --mode wide`.

## Comment ça marche

Aucune magie, uniquement du mDNS et adb :

1. L'outil tire au sort un nom de service (`studio-` + 6 caractères) et un mot de passe
   (12 caractères), et affiche un QR contenant exactement :
   `WIFI:T:ADB;S:<serviceName>;P:<password>;;`
2. Le téléphone scanne ce code et publie un service mDNS `_adb-tls-pairing._tcp` dont le nom
   d'instance est ce `serviceName`.
3. L'outil sonde `adb mdns services` chaque seconde, trouve ce service, et lance
   `adb pair <ip>:<port> <password>`.
4. Une fois associé, le téléphone publie un service `_adb-tls-connect._tcp`, et l'outil exécute
   `adb connect <ip>:<port>`.

Deux subtilités que l'implémentation prend en compte :

- `adb pair` et `adb connect` renvoient le **code de sortie 0 même en cas d'échec**, en écrivant
  `Failed: …` sur la sortie standard. Les verdicts viennent donc du texte, jamais du code.
- La variable `ADB_MDNS_AUTO_CONNECT` vaut `adb-tls-connect` par défaut : **adb se connecte tout
  seul** aux appareils qu'il découvre, et le service disparaît alors avant qu'on ait pu s'en
  servir. L'outil surveille donc en parallèle le mDNS *et* `adb devices`, et n'exécute
  `adb connect` que s'il est réellement nécessaire.

## Développement

```bash
npm install
npm test          # tests unitaires du cœur — ne nécessitent PAS adb
npm run build     # compile le cœur puis bundle l'extension
npm run lint
npm run package   # produit le .vsix à la racine
```

Pour lancer l'extension : ouvrez le dépôt dans VS Code et appuyez sur `F5`.

**Règle d'architecture non négociable** : toute la logique vit dans `packages/core`.
`packages/vscode` ne contient que de l'interface et n'implémente aucun comportement. C'est ce qui
permet au même cœur de servir le CLI et de futurs portages vers d'autres éditeurs.

## Publication

La publication est déclenchée par un tag `v*` et gérée par
[`.github/workflows/release.yml`](.github/workflows/release.yml). Chaque étape est conditionnée à
la présence de son secret : sans le secret, l'étape est simplement sautée.

```bash
npm version 0.1.1 --workspaces --no-git-tag-version
git commit -am "chore: version 0.1.1"
git tag v0.1.1 && git push --follow-tags
```

### Créer les trois jetons

**`VSCE_PAT` — Marketplace Visual Studio** (pour VS Code)

1. Connectez-vous sur [dev.azure.com](https://dev.azure.com/) avec un compte Microsoft.
2. En haut à droite : *User settings* → *Personal access tokens* → **New Token**.
3. *Organization* : **All accessible organizations** — c'est indispensable, un jeton limité à une
   organisation est refusé par `vsce`.
4. *Scopes* : cliquez *Show all scopes*, puis **Marketplace → Manage**.
5. Copiez le jeton (il n'est plus affiché ensuite).
6. Créez l'éditeur `tialao` sur [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage).
7. Déposez le jeton dans *Settings → Secrets and variables → Actions* du dépôt GitHub, sous le
   nom `VSCE_PAT`.

**`OVSX_PAT` — Open VSX** (pour Cursor, Windsurf, VSCodium, Trae)

1. Connectez-vous sur [open-vsx.org](https://open-vsx.org/) avec GitHub.
2. *Settings* → *Access Tokens* → **Generate New Token**.
3. Signez l'accord d'éditeur (*Publisher Agreement*), obligatoire avant toute publication.
4. Créez l'espace de noms `tialao` : `npx ovsx create-namespace tialao -p <jeton>`.
5. Déposez le jeton sous le nom `OVSX_PAT`.

**`NPM_TOKEN` — npm** (pour le CLI `tadb`)

1. Connectez-vous sur [npmjs.com](https://www.npmjs.com/).
2. *Access Tokens* → **Generate New Token** → type **Automation** (il passe la 2FA en CI).
3. Déposez le jeton sous le nom `NPM_TOKEN`.

## Vie privée et sécurité

- **Aucune télémétrie, aucune requête réseau sortante.** Le QR code est généré
  localement ; toutes les opérations passent par le binaire `adb` de votre machine.
- **Le mot de passe d'association n'est jamais journalisé.** Il figure pourtant sur la
  ligne de commande `adb pair` : il est masqué avant écriture dans le journal, qui est
  fait pour être lu et collé dans un rapport de bug.
- **Aucune commande n'est construite par concaténation de chaînes.** Tout passe par
  `execFile` avec un tableau d'arguments, jamais par un shell — une règle ESLint
  interdit `exec` et `execSync` dans tout le projet.
- **Les webviews appliquent une CSP stricte** : `default-src 'none'`, script autorisé
  par nonce uniquement, aucune ressource distante. Les commandes qu'ils peuvent
  déclencher passent par une liste blanche, et les valeurs qu'ils envoient sont
  revalidées côté extension avant d'atteindre un processus.
- **Le serveur scrcpy est vérifié par empreinte SHA-256** avant chaque envoi sur
  l'appareil.
- **Rien n'écoute sur une interface publique.** Le tunnel du miroir est un
  `adb forward` vers `127.0.0.1`, sur un port éphémère libéré en fin de session.
- **L'historique des appareils** ne contient ni mot de passe ni secret : seulement un
  nom, un identifiant stable et la dernière adresse vue.

## Licence

[MIT](LICENSE)
