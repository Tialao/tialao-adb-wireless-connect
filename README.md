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

### 1. Depuis un marketplace (le plus simple)

- **VS Code** — [Marketplace Visual Studio](https://marketplace.visualstudio.com/) : cherchez
  « TIALAO ADB Wireless Connect ».
- **Cursor, Windsurf, VSCodium, Trae** — ces éditeurs utilisent
  [Open VSX](https://open-vsx.org/) : même recherche.

### 2. Script d'installation (installe sur tous les éditeurs détectés)

Le script télécharge le `.vsix` de la dernière version publiée, détecte les éditeurs présents sur
la machine et l'installe sur chacun, en ignorant silencieusement les absents.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Tialao/tialao-adb-wireless-connect/main/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Tialao/tialao-adb-wireless-connect/main/scripts/install.ps1 | iex
```

### 3. `.vsix` manuel

Téléchargez le `.vsix` depuis la
[page des versions](https://github.com/Tialao/tialao-adb-wireless-connect/releases), puis :

```bash
code     --install-extension tialao-adb-wireless-connect.vsix
cursor   --install-extension tialao-adb-wireless-connect.vsix
windsurf --install-extension tialao-adb-wireless-connect.vsix
codium   --install-extension tialao-adb-wireless-connect.vsix
trae     --install-extension tialao-adb-wireless-connect.vsix
```

Le **même** `.vsix` fonctionne sur tous ces éditeurs ; seul le nom de la commande change.

### 4. CLI seul (sans éditeur)

```bash
npm install -g tialao-adb-wireless
tadb pair-qr
```

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

## Licence

[MIT](LICENSE)
