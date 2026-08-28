/**
 * Erreurs du coeur, avec un code stable et un « hint » actionnable.
 *
 * Le hint n'est pas décoratif : c'est lui qui distingue « command failed » d'un message
 * qui dit à l'utilisateur quoi faire. Il est affiché tel quel par le CLI et par
 * les notifications VS Code, et sérialisé en mode `--json`.
 */

export type TadbErrorCode =
  | 'ADB_NOT_FOUND'
  | 'ADB_EXEC_FAILED'
  | 'ADB_TIMEOUT'
  | 'MDNS_UNAVAILABLE'
  | 'MDNS_NO_SERVICES'
  | 'PAIR_FAILED'
  | 'PAIR_WRONG_PASSWORD'
  | 'CONNECT_FAILED'
  | 'NO_DEVICE'
  | 'INVALID_ARGUMENT'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'STORAGE_ERROR';

/** Codes de sortie du CLI, stables : un script tiers peut s'y fier. */
export const EXIT_CODES = {
  ok: 0,
  failure: 1,
  usage: 2,
  adbNotFound: 3,
  timeout: 4,
  cancelled: 5,
  mdnsUnavailable: 6,
} as const;

export function exitCodeFor(code: TadbErrorCode): number {
  switch (code) {
    case 'ADB_NOT_FOUND':
      return EXIT_CODES.adbNotFound;
    case 'ADB_TIMEOUT':
    case 'TIMEOUT':
      return EXIT_CODES.timeout;
    case 'CANCELLED':
      return EXIT_CODES.cancelled;
    case 'MDNS_UNAVAILABLE':
      return EXIT_CODES.mdnsUnavailable;
    case 'INVALID_ARGUMENT':
      return EXIT_CODES.usage;
    default:
      return EXIT_CODES.failure;
  }
}

export interface TadbErrorOptions {
  hint?: string;
  cause?: unknown;
  /** Sortie brute d'adb, conservée pour le journal. */
  raw?: string;
}

export class TadbError extends Error {
  readonly code: TadbErrorCode;
  readonly hint: string | undefined;
  readonly raw: string | undefined;

  constructor(code: TadbErrorCode, message: string, options: TadbErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TadbError';
    this.code = code;
    this.hint = options.hint ?? DEFAULT_HINTS[code];
    this.raw = options.raw;
  }

  toJSON(): { code: TadbErrorCode; message: string; hint?: string } {
    return this.hint !== undefined
      ? { code: this.code, message: this.message, hint: this.hint }
      : { code: this.code, message: this.message };
  }
}

/** Hints par défaut, en français, orientés « quoi faire maintenant ». */
const DEFAULT_HINTS: Record<TadbErrorCode, string | undefined> = {
  ADB_NOT_FOUND:
    "Installez les platform-tools Android, ou renseignez le chemin complet vers adb (setting tialaoAdb.adbPath, ou option --adb du CLI).",
  ADB_EXEC_FAILED: "Consultez la sortie brute d'adb ci-dessus pour le détail.",
  ADB_TIMEOUT:
    "adb n'a pas répondu à temps. Essayez « Restart ADB server », ou vérifiez qu'aucun autre outil (Android Studio, scrcpy) ne monopolise le serveur adb.",
  MDNS_UNAVAILABLE:
    "Le backend mDNS d'adb est indisponible. Redémarrez le serveur adb ; si le problème persiste, utilisez l'association par code à 6 chiffres, qui ne dépend pas du mDNS.",
  MDNS_NO_SERVICES:
    "Aucun service découvert. Vérifiez que le PC et le téléphone sont sur le MÊME réseau Wi-Fi, que le réseau Windows est en profil « Privé », que le pare-feu autorise adb.exe, et que le routeur n'isole pas les clients. Vous pouvez sinon saisir manuellement l'adresse IP:port affichée sur le téléphone.",
  PAIR_FAILED:
    "Relancez l'association depuis le téléphone (Débogage sans fil → Associer l'appareil), le code et le service expirent vite.",
  PAIR_WRONG_PASSWORD:
    "Le code d'association est incorrect ou a expiré. Rouvrez « Associer l'appareil à l'aide d'un code d'association » sur le téléphone pour en obtenir un nouveau.",
  CONNECT_FAILED:
    "Le port de connexion change à chaque redémarrage du téléphone. Relancez une découverte plutôt que de réutiliser une ancienne adresse.",
  NO_DEVICE: "Aucun appareil correspondant. Lancez « Show connected devices » pour voir l'état réel.",
  INVALID_ARGUMENT: undefined,
  CANCELLED: undefined,
  TIMEOUT: undefined,
  STORAGE_ERROR:
    "L'historique des appareils n'a pas pu être écrit. Vérifiez les droits sur votre dossier utilisateur, ou définissez TIALAO_ADB_HOME vers un dossier accessible en écriture.",
};

/** Normalise n'importe quoi en TadbError, pour que les couches UI aient toujours un code. */
export function toTadbError(error: unknown, fallbackCode: TadbErrorCode = 'ADB_EXEC_FAILED'): TadbError {
  if (error instanceof TadbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new TadbError(fallbackCode, message, { cause: error });
}
