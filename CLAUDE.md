# CLAUDE.md — mémoire de projet

Ce fichier ne contient que ce qu'une session repartant de zéro ne pourrait **pas** deviner en
lisant le code. Pas de journal de session : uniquement du savoir durable.

## Conventions

- Réponses et commentaires de code **en français**.
- TypeScript **strict**, syntaxe effaçable (`erasableSyntaxOnly`) : pas d'`enum`, pas de
  `namespace`, pas de propriétés de paramètres de constructeur — c'est ce qui permet à
  `node --test` d'exécuter les `.ts` directement, sans étape de compilation.
- **Aucune dépendance réseau**, **aucune télémétrie**. Seule dépendance runtime : `qrcode`.
- `child_process.exec` et `execSync` sont **interdits** (règle ESLint) : tout passe par
  `execFile` dans `packages/core/src/adb.ts`.
- `console.*` est **interdit** hors `cli.ts` (règle ESLint) : c'est ce qui garantit qu'en mode
  `--json`, stdout ne contient que du JSON.

## Règle d'architecture — non négociable

Toute la logique vit dans **`packages/core`**. **`packages/vscode` ne contient que de
l'interface** et ne réimplémente jamais un comportement. C'est ce qui permet au même cœur de
servir le CLI `tadb` et de futurs portages (JetBrains, Zed…) sans réécriture.

## Le mécanisme adb sans fil

1. On tire un `serviceName` = `studio-` + 6 alphanumériques, et un `password` de 12
   alphanumériques, puis on affiche un QR contenant **exactement** :
   `WIFI:T:ADB;S:<serviceName>;P:<password>;;`
2. Le téléphone scanne (Débogage sans fil → Associer avec un QR code) et publie un service mDNS
   `_adb-tls-pairing._tcp` dont le **nom d'instance est ce `serviceName`**.
3. On sonde `adb mdns services`, on trouve ce service, on lance `adb pair <ip>:<port> <password>`.
4. Le téléphone publie ensuite `_adb-tls-connect._tcp`, et on lance `adb connect <ip>:<port>`.

**Alphabet strictement alphanumérique** : la grammaire `WIFI:` réserve `\ ; , : "` et impose de
les échapper. En n'en générant jamais, aucun échappement n'est nécessaire — invariant garanti par
un test de round-trip dans `qr.test.ts`.

## Formats vérifiés empiriquement

Testé le **2026-08-28** avec **adb 1.0.41, révision 35.0.2-12147458**, sous Windows 11
(10.0.26200), sur un **Samsung SM-A175F (Android 16)**.

**`adb mdns check`** — le backend Openscreen est **actif par défaut** sur cette version :

```
mdns daemon version [Openscreen discovery 0.0.0]
```

Le repli `ADB_MDNS_OPENSCREEN=1` reste implémenté pour les versions antérieures, mais n'est pas
nécessaire ici.

**`adb mdns services`** — **confirmé sur une capture d'octets bruts**, Débogage sans fil actif.
Séquences d'échappement écrites explicitement — c'est tout l'intérêt de la capture :

```text
List of discovered mdns services\r\n
adb-RZGL111VD2M-86k6NG\t_adb-tls-connect._tcp\t192.168.95.90:34509\r\n\r\n
```

Trois points que seule la capture brute permettait de trancher :

- le séparateur est une **tabulation unique** (`\t`), et non des espaces multiples ;
- le type n'a **pas de point final** : `_adb-tls-connect._tcp`, et non `._tcp.` ;
- les lignes sont en **CRLF**, et une ligne vide termine la sortie.

Le parser reste néanmoins tolérant (espaces multiples, point final optionnel) et conserve
toujours la ligne brute dans `MdnsService.raw` : ces variantes sont testées à titre défensif,
pour ne pas casser sur une autre version d'adb. Fixture réelle :
`packages/core/test/fixtures/mdns-connect-real.crlf.txt`.

**Nuance importante sur l'auto-connect** : lors de cette capture, le service
`_adb-tls-connect._tcp` était publié alors que `adb devices` restait **vide**.
`ADB_MDNS_AUTO_CONNECT` ne connecte donc automatiquement que les appareils **déjà appairés avec
ce poste** (ceux dont adb possède la clé), pas un appareil inconnu. La course à deux pistes de
`pairing.ts` reste indispensable, mais c'est surtout aux **reconnexions** qu'elle se déclenche,
pas au tout premier appairage.

**Flux d'association complet, observé de bout en bout** (2026-08-28, SM-A175F) :

```text
studio-KVmTrb\t_adb-tls-pairing._tcp\t192.168.95.90:33995
adb-RZGL111VD2M-86k6NG\t_adb-tls-connect._tcp\t192.168.95.90:34509
```

`adb pair 192.168.95.90:33995 <mot de passe>` répond :
`Successfully paired to 192.168.95.90:33995 [guid=adb-RZGL111VD2M-86k6NG]`.

**Les deux services sont sur des ports DIFFÉRENTS** (33995 pour l'association, 34509 pour la
connexion) : il faut bien deux découvertes mDNS distinctes, on ne peut pas réutiliser l'adresse
d'association pour se connecter.

**Un appareil connecté sans fil apparaît DEUX FOIS dans `adb devices -l`** — une entrée TCP et
une entrée mDNS, avec des `transport_id` différents :

```text
192.168.95.90:34509    device product:a17xx model:SM_A175F device:a17 transport_id:3
adb-RZGL111VD2M-86k6NG._adb-tls-connect._tcp.    device product:a17xx model:SM_A175F device:a17 transport_id:5
```

Les deux entrées n'ont **aucun identifiant commun** (l'une n'a que son adresse, l'autre le serial
USB). → `dedupeDevices()` les rapproche sur la signature `product|model|device`, et **uniquement
entre transports différents**, pour que N téléphones du même modèle restent comptés N fois.
L'entrée TCP est conservée : c'est la seule sur laquelle `adb disconnect` agit. Le mode `--json`
du CLI expose en revanche la liste **brute**, un consommateur machine devant voir ce qu'adb voit.

**`adb devices -l`** :

```
List of devices attached
RZGL111VD2M            device product:a17xx model:SM_A175F device:a17 transport_id:1
```

**`adb shell ip route`** — l'IP est le jeton qui suit `src` :

```
192.168.95.0/24 dev wlan0 proto kernel scope link src 192.168.95.90
```

## Pièges rencontrés, et leur solution

**`adb pair` et `adb connect` renvoient le code de sortie 0 même en cas d'échec**, en écrivant
`Failed: …` / `failed to connect to …` sur **stdout**. → Tous les verdicts viennent du parsing du
texte (`parsePairOutput`, `parseConnectOutput`) ; le code de sortie n'est qu'un signal secondaire.

**`ADB_MDNS_AUTO_CONNECT` vaut `adb-tls-connect` par défaut** (visible dans `adb --help`) : le
serveur adb **se connecte tout seul** aux services de connexion qu'il découvre, et le service
disparaît de la liste aussitôt consommé. → Après l'association, `raceToConnected` surveille
**deux pistes en parallèle** : le service mDNS (piste A, qui déclenche `adb connect`) et
`adb devices` (piste B, l'auto-connect). La première qui aboutit gagne, et `adb connect` n'est
pas lancé si la piste B a déjà gagné. `already connected to …` est un **succès**.

**Aucun jeton commun entre les deux services mDNS** : le service d'association s'appelle
`studio-xxxxxx` (notre nom) et le service de connexion `adb-<serialUSB>-XXXXXX`. → Le seul lien
est l'**adresse IP** relevée sur le service d'association, corroborée par le `guid` que renvoie
`adb pair`.

**Un instantané de `adb devices` AVANT l'association est obligatoire** : sans lui, impossible de
distinguer un appareil auto-connecté par notre flux d'un appareil qui était déjà branché.

**Le port de connexion change à chaque redémarrage du téléphone.** → `lastPort` est stocké à
titre purement indicatif et **n'est jamais réutilisé** pour se reconnecter : on redécouvre
toujours le port en mDNS.

**Un mDNS muet ne renvoie jamais d'erreur** : il renvoie une liste vide, indéfiniment. Causes
usuelles sous Windows : `adb.exe` non autorisé par le pare-feu Defender, ou profil réseau
« Public ». → Après 15 sondages vides, un événement `silent` remonte un message explicite et
propose la saisie manuelle de l'`ip:port`.

**Le timer de sondage mDNS ne doit surtout PAS être `unref()`.** Pendant l'attente du scan, ce
timer est la seule chose qui maintienne la boucle d'événements en vie : avec `unref()`,
`tadb pair-qr` sortait tout seul (code 13) juste après le premier sondage, sans jamais laisser le
temps de scanner. Aucun test unitaire ne le voyait — c'est le test réel qui l'a révélé. Un test de
régression le verrouille désormais via `process.getActiveResourcesInfo()`.

**Le sondage mDNS utilise une chaîne de `setTimeout`, jamais `setInterval`** : au démarrage du
daemon, `adb mdns services` peut dépasser une seconde, et un intervalle fixe empilerait les
processus adb.

**Les événements du flux sont émis après un `await Promise.resolve()`** : sans cette césure,
`qr-ready` partait pendant l'appel à `startQrPairing()`, avant que l'appelant ait pu s'abonner —
le webview n'affichait alors aucun QR.

**CRLF** : adb sort du `\r\n` sous Windows. Un `\r` résiduel casse silencieusement
`parseInt(port)` et les comparaisons `instance === serviceName`. → `split(/\r?\n/)` partout, et
les fixtures `.crlf.txt` sont exclues de la normalisation par `.gitattributes` (`-text`), sinon
git les convertirait et le test ne testerait plus rien.

**Le webview et la scannabilité du QR** : le QR reste **toujours sombre sur fond clair**, dans un
cadre blanc fixe, quel que soit le thème de l'éditeur. Un QR qui suit un thème sombre, ou un QR
inversé, n'est pas scanné de façon fiable par Android. Seul le décor autour utilise les variables
`--vscode-*`. Correction d'erreur **niveau Q** pour absorber la stylisation (modules arrondis).

**`packages/vscode` se typecheck en `module: preserve` / `moduleResolution: bundler`**, pas en
`nodenext`. Il n'a pas `"type": "module"` — et ne doit pas en avoir, l'hôte d'extension fait un
`require()` sur `dist/extension.js` — donc `nodenext` le traiterait comme du CommonJS et
refuserait la syntaxe ESM des sources.

**`@types/vscode` est épinglé sur `~1.85.0`**, pas sur la dernière version : compiler contre une
API plus récente que le `engines` déclaré est exactement ce qui casse sur Cursor, qui suit VS Code
avec du retard.

## Commandes utiles

```bash
npm install
npm test                              # tests du cœur, sans binaire adb requis
npm run test:watch -w packages/core
npm run build                         # cœur (tsc) puis extension (esbuild)
npm run lint
npm run package                       # produit le .vsix à la racine
npx vsce ls --no-dependencies         # audit du contenu du .vsix, à faire avant chaque release
node packages/core/bin/tadb.mjs devices --json
```

## Packaging du `.vsix`

Le cœur est **inliné par esbuild** dans `dist/extension.js` (il n'est pas déclaré `external`), et
`.vscodeignore` exclut `node_modules/**`. Le `.vsix` ne contient donc que `package.json`,
`dist/extension.js`, `media/*`, README, CHANGELOG et LICENSE — aucune dépendance à résoudre à
l'installation, et aucun des ennuis de `vsce` avec les dépendances liées d'un monorepo.

esbuild consomme le **`dist` du cœur, pas son `src`** : le typecheck de l'extension se fait donc
contre la surface réellement publiée (`exports` + `.d.ts`). L'ordre de build est imposé :
`core:tsc → vscode:typecheck → vscode:esbuild → vsce package`.

## Marketplace VS Code ≠ Open VSX

Deux registres distincts, et il faut publier sur **les deux** pour une installation en un clic
partout :

| Secret | Registre | Éditeurs desservis |
| --- | --- | --- |
| `VSCE_PAT` | Marketplace Visual Studio (Microsoft) | VS Code |
| `OVSX_PAT` | [Open VSX](https://open-vsx.org/) | Cursor, Windsurf, VSCodium, Trae |
| `NPM_TOKEN` | npm | le CLI `tadb` |

Le `.vsix` est **identique** pour les deux registres. Dans le workflow de release, chaque étape de
publication est conditionnée à la présence de son secret : sans le secret, l'étape est sautée
sans faire échouer la release.
