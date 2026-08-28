/**
 * Types partages du coeur. Aucun runtime ici : ce fichier doit s'effacer entierement
 * a la compilation (contrainte `erasableSyntaxOnly`, cf. tsconfig.base.json).
 */

/** Etat d'un appareil tel que rapporte par `adb devices`. */
export type DeviceState =
  | 'device'
  | 'offline'
  | 'unauthorized'
  | 'authorizing'
  | 'connecting'
  | 'bootloader'
  | 'recovery'
  | 'sideload'
  | 'rescue'
  | 'host'
  | 'no permissions'
  | 'unknown';

/** Par quel canal l'appareil est rattache au serveur adb. */
export type DeviceTransport = 'usb' | 'tcp' | 'mdns';

export interface AdbDevice {
  /** Serial brut : `RZGL111VD2M`, `192.168.95.90:37123`, ou `adb-RZGL111VD2M-XXXXXX._adb-tls-connect._tcp.` */
  serial: string;
  state: DeviceState;
  transport: DeviceTransport;
  /** Serial USB reel, extrait quand le serial est une instance mDNS. */
  usbSerial?: string;
  /** Renseignes seulement pour un appareil joint en TCP. */
  host?: string;
  port?: number;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
  /** Ligne brute, toujours conservee : le format de sortie d'adb n'est stable qu'a une version donnee. */
  raw: string;
}

export const PAIRING_SERVICE_TYPE = '_adb-tls-pairing._tcp';
export const CONNECT_SERVICE_TYPE = '_adb-tls-connect._tcp';

export interface MdnsService {
  /** Nom d'instance. Pour le pairing, il vaut exactement le `serviceName` encode dans le QR. */
  instance: string;
  /** Type normalise, point final retire : `_adb-tls-pairing._tcp` ou `_adb-tls-connect._tcp`. */
  type: string;
  /** IPv4, ou IPv6 debracketee (la zone `%iface` est conservee). */
  host: string;
  port: number;
  raw: string;
}

export interface MdnsCheck {
  available: boolean;
  backend: 'openscreen' | 'bonjour' | 'unknown';
  version?: string;
  raw: string;
}

export interface HostPort {
  host: string;
  port: number;
}

export interface PairingCredentials {
  /** `studio-` + 6 caracteres alphanumeriques. */
  serviceName: string;
  /** 12 caracteres alphanumeriques. */
  password: string;
}

/** Pourquoi un `adb pair` a echoue, quand adb le dit assez clairement pour le classer. */
export type PairFailureReason =
  | 'wrong-password'
  | 'refused'
  | 'unreachable'
  | 'timeout'
  | 'unknown';

export interface PairResult {
  ok: boolean;
  address?: HostPort;
  /** `guid=adb-<usbSerial>-XXXXXX` renvoye par adb en cas de succes. */
  guid?: string;
  usbSerial?: string;
  reason?: PairFailureReason;
  /** Un nouvel essai a-t-il une chance d'aboutir ? Faux pour un mot de passe errone. */
  retryable: boolean;
  message: string;
  raw: string;
}

export interface ConnectResult {
  ok: boolean;
  address?: HostPort;
  /** adb a repondu `already connected to ...` : c'est un succes, pas une erreur. */
  alreadyConnected: boolean;
  message: string;
  raw: string;
}

export interface AdbVersion {
  /** Version du protocole, ex. `1.0.41`. */
  version: string;
  /** Revision du paquet platform-tools, ex. `35.0.2-12147458`. */
  revision?: string;
  installedAs?: string;
  raw: string;
}

/** Appareil memorise dans l'historique local, partage entre le CLI et l'extension. */
export interface StoredDevice {
  /** Identifiant stable : serial USB si connu, sinon derniere adresse hote. */
  id: string;
  label: string;
  model?: string;
  usbSerial?: string;
  lastSeenIp?: string;
  /**
   * Dernier port vu. INDICE UNIQUEMENT, jamais fiable : le port de connexion change a
   * chaque redemarrage du telephone et doit etre redecouvert en mDNS.
   */
  lastPort?: number;
  pairedAt: string;
  lastConnectedAt?: string;
}

export interface DeviceHistoryFile {
  schemaVersion: 1;
  devices: StoredDevice[];
}

/** Resultat brut d'une invocation d'adb. */
export interface RawExec {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Commande effectivement lancee, pour le journal. */
  command: string;
}
