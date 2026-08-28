# TIALAO ADB Wireless Connect

Connectez un smartphone Android en **ADB sans fil** — par QR code ou par code d'association à
6 chiffres — sans ouvrir Android Studio.

C'est le « Wireless debugging / Pair device » d'Android Studio, directement dans votre éditeur.

## Fonctionnalités

- **Associer avec un QR code** — un panneau affiche le code à scanner, puis détecte le téléphone,
  l'associe et le connecte automatiquement. L'avancement s'affiche en direct : *attente du scan →
  association → connexion → connecté*.
- **Associer avec un code à 6 chiffres** — quand la découverte réseau ne fonctionne pas.
- **Connecter / déconnecter** — la liste combine les appareils visibles sur le réseau et ceux déjà
  associés.
- **Mode TCP/IP** pour Android 10 et antérieurs, avec récupération automatique de l'adresse IP.
- **Redémarrer le serveur adb** — le remède au statut `offline`.
- **Barre d'état** cliquable indiquant l'appareil connecté, et un **journal** consignant chaque
  commande adb avec sa sortie brute.

Toutes les commandes sont dans la palette (`Ctrl+Shift+P`) sous le préfixe **TIALAO ADB:**.

## Prérequis

- Les **platform-tools Android** (`adb`). L'extension cherche automatiquement le binaire dans les
  emplacements standards du SDK ; sinon, renseignez `tialaoAdb.adbPath`.
- **Android 11 ou plus récent** pour l'association sans fil. Pour Android 10 et antérieurs,
  utilisez le mode TCP/IP (nécessite un premier branchement USB).
- L'ordinateur et le téléphone sur le **même réseau Wi-Fi**, sans isolation des clients.
- Les **options pour les développeurs** activées, avec le **Débogage sans fil**.

## Démarrage rapide

1. `Ctrl+Shift+P` → **TIALAO ADB: Pair device with QR code**
2. Sur le téléphone : **Paramètres → Options pour les développeurs → Débogage sans fil →
   Associer l'appareil à l'aide d'un QR code**
3. Scannez le code affiché. Le reste est automatique.

## Réglages

| Réglage | Défaut | Rôle |
| --- | --- | --- |
| `tialaoAdb.adbPath` | `"adb"` | Chemin vers le binaire adb |
| `tialaoAdb.autoConnectOnStartup` | `false` | Reconnecter le dernier appareil à l'ouverture |
| `tialaoAdb.discoveryTimeout` | `120` | Timeout de découverte, en secondes |
| `tialaoAdb.showStatusBar` | `true` | Afficher l'appareil dans la barre d'état |
| `tialaoAdb.disableMdnsAutoConnect` | `false` | Empêcher adb de se connecter seul aux appareils découverts |

## En cas de problème

Ouvrez d'abord le journal : *Affichage → Sortie → « TIALAO ADB »*. Il contient chaque commande
adb lancée et sa sortie brute.

**La découverte ne trouve rien** (le cas le plus fréquent sous Windows) : autorisez `adb.exe` dans
le pare-feu Windows Defender, et vérifiez que votre Wi-Fi est en profil **Privé** et non
**Public** — le mDNS est bloqué sur un réseau public. À défaut, utilisez l'association par code à
6 chiffres, qui ne dépend pas de la découverte réseau.

**« Ça marchait hier »** : le port de connexion change à chaque redémarrage du téléphone. C'est
normal. Relancez **Connect to device**, qui redécouvre le port courant — l'appareil reste associé.

La [section Dépannage du README](https://github.com/Tialao/tialao-adb-wireless-connect#dépannage)
couvre aussi : adb introuvable, appareil `offline`, isolation des clients Wi-Fi, Android 10.

## Aussi disponible en ligne de commande

Toute la logique de cette extension vit dans un paquet npm autonome, utilisable depuis n'importe
quel éditeur (Android Studio, JetBrains, Zed, Neovim…) ou depuis un simple terminal :

```bash
npm install -g tialao-adb-wireless
tadb pair-qr
```

Le CLI dispose aussi d'un mode `--json` pour être piloté par un script.

## Vie privée

Aucune télémétrie, aucune requête réseau sortante. Le QR code est généré localement, et toutes les
opérations passent par le binaire `adb` de votre machine.

## Licence

[MIT](LICENSE) — [code source](https://github.com/Tialao/tialao-adb-wireless-connect)
