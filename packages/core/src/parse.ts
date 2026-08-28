/**
 * Parsers PURS des sorties d'adb : `string -> typé`, zéro I/O, zéro dépendance.
 *
 * Tout est ici plutôt que dans `adb.ts` pour une raison précise : ces fonctions sont la
 * partie la plus fragile du projet (les formats d'adb ne sont stables qu'à une version
 * donnée) et les isoler permet de les tester exhaustivement SANS binaire adb installé.
 *
 * Deux règles appliquées partout :
 *  - `split(/\r?\n/)` systématique : adb sort du CRLF sous Windows, et un `\r` résiduel
 *    casse silencieusement `parseInt(port)` et les comparaisons `instance === serviceName`.
 *  - la ligne brute est toujours conservée dans le résultat (`raw`).
 */

import type {
  AdbDevice,
  AdbVersion,
  ConnectResult,
  DeviceState,
  DeviceTransport,
  HostPort,
  MdnsCheck,
  MdnsService,
  PairFailureReason,
  PairResult,
  RawExec,
} from './types.ts';
import { CONNECT_SERVICE_TYPE, PAIRING_SERVICE_TYPE } from './types.ts';

const DEVICE_STATES: readonly string[] = [
  'device',
  'offline',
  'unauthorized',
  'authorizing',
  'connecting',
  'bootloader',
  'recovery',
  'sideload',
  'rescue',
  'host',
];

/** Lignes de service qu'adb intercale et qui ne font partie d'aucune sortie utile. */
const NOISE_PATTERNS: readonly RegExp[] = [
  /^\*\s/, // "* daemon not running; starting now at tcp:5037", "* daemon started successfully"
  /^List of devices attached/i,
  /^List of discovered mdns services/i,
  /^adb server version .* doesn't match this client/i,
  /^\s*$/,
];

/** Découpe en lignes en absorbant CRLF/CR, et retire les espaces de bord de chaque ligne. */
export function toLines(text: string): string[] {
  return text.split(/\r?\n|\r/).map((l) => l.trim());
}

/** Retire les lignes de bruit (daemon, en-têtes, lignes vides) d'une sortie adb. */
export function stripAdbNoise(text: string): string[] {
  return toLines(text).filter((line) => !NOISE_PATTERNS.some((re) => re.test(line)));
}

/**
 * Découpe `host:port`, en gérant l'IPv6 bracketée `[fe80::1%wlan0]:41234`.
 * Renvoie `null` si ce n'est pas une adresse hôte:port plausible.
 */
export function parseHostPort(text: string): HostPort | null {
  const value = text.trim().replace(/[.,;]+$/, '');
  if (!value) return null;

  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
  if (bracketed) {
    const port = Number(bracketed[2]);
    return isValidPort(port) ? { host: bracketed[1] as string, port } : null;
  }

  // IPv4 ou nom d'hôte : un seul ':' attendu. Plusieurs ':' sans crochets = IPv6 sans port.
  const idx = value.lastIndexOf(':');
  if (idx <= 0 || idx === value.length - 1) return null;
  const host = value.slice(0, idx);
  if (host.includes(':')) return null;
  const port = Number(value.slice(idx + 1));
  if (!isValidPort(port)) return null;
  return { host, port };
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

export function formatHostPort(addr: HostPort): string {
  return addr.host.includes(':') ? `[${addr.host}]:${addr.port}` : `${addr.host}:${addr.port}`;
}

/* --------------------------------------------------------------------------------------- */
/* adb devices [-l]                                                                          */
/* --------------------------------------------------------------------------------------- */

// Les seules clés que `adb devices -l` ajoute en fin de ligne. On les extrait explicitement
// plutôt que de découper sur ':' : l'état "no permissions (...)" contient lui-même des ':'
// dans son URL d'aide, ce qui piégerait un découpage naïf.
const DEVICE_PROPS_RE = /\b(product|model|device|transport_id):(\S+)/g;

/** Parse la sortie de `adb devices` ou `adb devices -l`. */
export function parseDevices(stdout: string): AdbDevice[] {
  const devices: AdbDevice[] = [];

  for (const raw of stripAdbNoise(stdout)) {
    const m = /^(\S+)\s+(.+)$/.exec(raw);
    if (!m) continue;
    const serial = m[1] as string;
    let rest = m[2] as string;

    const props: Record<string, string> = {};
    rest = rest.replace(DEVICE_PROPS_RE, (_full, key: string, value: string) => {
      props[key] = value;
      return '';
    });

    const device: AdbDevice = {
      serial,
      state: normalizeDeviceState(rest),
      transport: detectTransport(serial),
      raw,
    };

    const usbSerial = usbSerialFromMdnsSerial(serial);
    if (usbSerial) device.usbSerial = usbSerial;

    const addr = device.transport === 'tcp' ? parseHostPort(serial) : null;
    if (addr) {
      device.host = addr.host;
      device.port = addr.port;
    }

    if (props['product']) device.product = props['product'];
    if (props['model']) device.model = props['model'];
    if (props['device']) device.device = props['device'];
    if (props['transport_id']) device.transportId = props['transport_id'];

    devices.push(device);
  }

  return devices;
}

function normalizeDeviceState(rest: string): DeviceState {
  const value = rest.trim();
  // Seul état multi-mots, suivi d'une parenthèse explicative : "no permissions (user in plugdev...)"
  if (/^no permissions\b/i.test(value)) return 'no permissions';
  const first = value.split(/\s+/)[0]?.toLowerCase() ?? '';
  return DEVICE_STATES.includes(first) ? (first as DeviceState) : 'unknown';
}

function detectTransport(serial: string): DeviceTransport {
  if (/\._tcp\.?$/.test(serial)) return 'mdns';
  return parseHostPort(serial) ? 'tcp' : 'usb';
}

/**
 * Extrait le serial USB d'une instance mDNS `adb-RZGL111VD2M-abc123._adb-tls-connect._tcp.`
 * Le suffixe après le dernier tiret est un discriminant aléatoire ajouté par le téléphone.
 */
export function usbSerialFromMdnsSerial(serial: string): string | undefined {
  // Retirer d'abord le suffixe de type de service : les tirets de `_adb-tls-connect`
  // fausseraient la recherche du dernier tiret, qui délimite le discriminant aléatoire.
  const bare = serial.trim().replace(/\._[A-Za-z0-9-]+\._(?:tcp|udp)\.?$/, '');
  const m = /^adb-(.+)-[^-]+$/.exec(bare);
  return m ? (m[1] as string) : undefined;
}

/* --------------------------------------------------------------------------------------- */
/* adb mdns services / adb mdns check                                                        */
/* --------------------------------------------------------------------------------------- */

/**
 * Une ligne de `adb mdns services` : `instance<sep>type<sep>host:port`.
 * Le séparateur est documenté comme une tabulation, mais on accepte aussi les espaces
 * multiples : selon la version d'adb, l'un ou l'autre a été observé.
 * Le point final du type (`._tcp.`) est optionnel.
 */
const MDNS_LINE_RE =
  /^(.+?)[ \t]+(_[A-Za-z0-9-]+\._(?:tcp|udp)\.?)[ \t]+(\[[^\]]+\]|[^\s]+?):(\d{1,5})$/;

export function parseMdnsServices(stdout: string): MdnsService[] {
  const services: MdnsService[] = [];

  for (const raw of stripAdbNoise(stdout)) {
    const m = MDNS_LINE_RE.exec(raw);
    if (!m) continue;

    const port = Number(m[4]);
    if (!isValidPort(port)) continue;

    const host = (m[3] as string).replace(/^\[|\]$/g, '');
    if (!host) continue;

    services.push({
      instance: (m[1] as string).trim(),
      type: (m[2] as string).replace(/\.$/, ''),
      host,
      port,
      raw,
    });
  }

  return services;
}

/** Trouve le service d'association publié par le téléphone après le scan du QR. */
export function findPairingService(
  services: readonly MdnsService[],
  serviceName: string,
): MdnsService | undefined {
  return services.find((s) => s.type === PAIRING_SERVICE_TYPE && s.instance === serviceName);
}

/** Trouve le service de connexion correspondant à l'IP relevée lors de l'association. */
export function findConnectServiceForHost(
  services: readonly MdnsService[],
  host: string,
): MdnsService | undefined {
  return services.find((s) => s.type === CONNECT_SERVICE_TYPE && s.host === host);
}

export function parseMdnsCheck(stdout: string, stderr: string, code: number | null): MdnsCheck {
  const raw = [stdout, stderr].filter(Boolean).join('\n').trim();
  const text = raw.toLowerCase();

  if (text.includes('openscreen')) {
    const version = /openscreen discovery ([0-9][0-9.]*)/i.exec(raw)?.[1];
    return version !== undefined
      ? { available: true, backend: 'openscreen', version, raw }
      : { available: true, backend: 'openscreen', raw };
  }
  if (text.includes('bonjour')) {
    const version = /bonjour(?:[^0-9]*?)([0-9][0-9.]*)/i.exec(raw)?.[1];
    return version !== undefined
      ? { available: true, backend: 'bonjour', version, raw }
      : { available: true, backend: 'bonjour', raw };
  }
  // "ERROR: mdns daemon unavailable", ou toute sortie signalant l'indisponibilité.
  return { available: false, backend: 'unknown', raw: raw || `code=${String(code)}` };
}

/* --------------------------------------------------------------------------------------- */
/* adb pair / adb connect                                                                    */
/* --------------------------------------------------------------------------------------- */

/**
 * PIÈGE CENTRAL DU PROJET : `adb pair` et `adb connect` renvoient le code de sortie 0
 * même en cas d'échec, en écrivant `Failed: ...` sur stdout. Le verdict vient donc
 * TOUJOURS du texte ; le code de sortie n'est qu'un signal secondaire.
 */
export function parsePairOutput(exec: RawExec): PairResult {
  const raw = [exec.stdout, exec.stderr].filter((s) => s.trim()).join('\n');
  const text = stripAdbNoise(raw).join('\n');

  const success = /Successfully paired to\s+(\S+?)\s*(?:\[guid=([^\]]+)\])?\s*$/im.exec(text);
  if (success) {
    const address = parseHostPort(success[1] as string);
    const guid = success[2]?.trim();
    const result: PairResult = {
      ok: true,
      retryable: false,
      message: text.trim() || 'Association reussie.',
      raw,
    };
    if (address) result.address = address;
    if (guid) {
      result.guid = guid;
      const usbSerial = usbSerialFromMdnsSerial(guid);
      if (usbSerial) result.usbSerial = usbSerial;
    }
    return result;
  }

  const reason = classifyPairFailure(text, exec.timedOut);
  return {
    ok: false,
    reason,
    // Un mot de passe erroné ne devient pas bon en réessayant : ne pas boucler dessus.
    retryable: reason !== 'wrong-password',
    message: text.trim() || "Echec de l'association, sans message d'erreur d'adb.",
    raw,
  };
}

function classifyPairFailure(text: string, timedOut: boolean): PairFailureReason {
  if (timedOut) return 'timeout';
  const t = text.toLowerCase();
  if (t.includes('wrong password') || t.includes('incorrect password')) return 'wrong-password';
  if (t.includes('connection refused')) return 'refused';
  if (t.includes('no route to host') || t.includes('network is unreachable')) return 'unreachable';
  if (t.includes('timed out') || t.includes('timeout')) return 'timeout';
  return 'unknown';
}

export function parseConnectOutput(exec: RawExec): ConnectResult {
  const raw = [exec.stdout, exec.stderr].filter((s) => s.trim()).join('\n');
  const text = stripAdbNoise(raw).join('\n');

  // "already connected to ..." est un SUCCÈS : avec ADB_MDNS_AUTO_CONNECT actif par défaut,
  // adb a très souvent déjà connecté l'appareil avant qu'on le lui demande.
  const already = /already connected to\s+(\S+)/i.exec(text);
  if (already) {
    const address = parseHostPort(already[1] as string);
    const result: ConnectResult = {
      ok: true,
      alreadyConnected: true,
      message: text.trim(),
      raw,
    };
    if (address) result.address = address;
    return result;
  }

  const connected = /^connected to\s+(\S+)/im.exec(text);
  if (connected) {
    const address = parseHostPort(connected[1] as string);
    const result: ConnectResult = {
      ok: true,
      alreadyConnected: false,
      message: text.trim(),
      raw,
    };
    if (address) result.address = address;
    return result;
  }

  return {
    ok: false,
    alreadyConnected: false,
    message: text.trim() || "Echec de la connexion, sans message d'erreur d'adb.",
    raw,
  };
}

/* --------------------------------------------------------------------------------------- */
/* adb shell ip ... / adb --version                                                          */
/* --------------------------------------------------------------------------------------- */

/** Interfaces ignorées lors de la recherche de l'IP : données mobiles, tunnels, loopback. */
const NON_WIFI_IFACE_RE = /^(lo|rmnet|ccmni|dummy|tun|ppp|usb|rndis|v4-rmnet)/;

/**
 * Extrait l'IP Wi-Fi de l'appareil, depuis `adb shell ip route` et, en second recours,
 * depuis `adb shell ip -f inet addr show wlan0`.
 */
export function parseDeviceIp(ipRoute: string, ipAddr?: string): string | null {
  const routes = toLines(ipRoute).filter((l) => l.includes(' src '));

  // wlan0 en priorité, puis toute interface qui n'est ni du mobile ni du loopback.
  const preferred =
    routes.find((l) => /\bdev\s+wlan\d*\b/.test(l)) ??
    routes.find((l) => {
      const dev = /\bdev\s+(\S+)/.exec(l)?.[1] ?? '';
      return dev !== '' && !NON_WIFI_IFACE_RE.test(dev);
    });

  if (preferred) {
    const ip = /\bsrc\s+(\S+)/.exec(preferred)?.[1];
    if (ip && isIpv4(ip)) return ip;
  }

  if (ipAddr) {
    for (const line of toLines(ipAddr)) {
      const m = /^inet\s+([0-9.]+)(?:\/\d{1,2})?\b/.exec(line);
      const ip = m?.[1];
      if (ip && isIpv4(ip) && ip !== '127.0.0.1') return ip;
    }
  }

  return null;
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function parseAdbVersion(stdout: string): AdbVersion {
  const raw = stdout.trim();
  const lines = toLines(stdout).filter(Boolean);

  const version = /Android Debug Bridge version\s+([0-9][0-9.]*)/i.exec(raw)?.[1] ?? 'inconnue';
  const revision = /^Version\s+(.+)$/im.exec(raw)?.[1]?.trim();
  const installedAs = /^Installed as\s+(.+)$/im.exec(raw)?.[1]?.trim();

  const result: AdbVersion = { version, raw: lines.join('\n') };
  if (revision) result.revision = revision;
  if (installedAs) result.installedAs = installedAs;
  return result;
}

/**
 * Regroupe les entrées qui désignent le même appareil physique.
 *
 * Observé en conditions réelles : après une connexion sans fil, `adb devices -l` liste
 * le même téléphone DEUX fois — une entrée TCP `192.168.95.90:34509` et une entrée mDNS
 * `adb-RZGL111VD2M-86k6NG._adb-tls-connect._tcp`. Sans regroupement, l'interface annonce
 * deux appareils connectés là où il n'y en a qu'un.
 *
 * Les deux entrées n'ont aucun identifiant commun (l'une n'a que son adresse, l'autre le
 * serial USB), donc le rapprochement se fait sur la signature `product|model|device`, et
 * uniquement entre entrées sans fil. Limite assumée : deux appareils du même modèle
 * connectés sans fil au même moment seraient fusionnés. L'entrée TCP est conservée en
 * priorité, car c'est celle sur laquelle `adb disconnect` agit.
 */
export function dedupeDevices(devices: readonly AdbDevice[]): AdbDevice[] {
  const result: AdbDevice[] = [];
  const seen = new Map<string, number>();

  for (const device of devices) {
    // Les appareils USB ont un serial fiable : jamais de fusion sur ceux-là.
    if (device.transport === 'usb') {
      result.push(device);
      continue;
    }

    // La clé ne peut PAS être le serial USB : l'entrée mDNS le porte, l'entrée TCP
    // ne porte que son adresse. Le seul point commun observable entre les deux est
    // la signature matérielle renvoyée par `adb devices -l`.
    const signature = [device.product, device.model, device.device].filter(Boolean).join('|');
    if (!signature) {
      result.push(device);
      continue;
    }

    const existingIndex = seen.get(signature);
    const existing = existingIndex === undefined ? undefined : (result[existingIndex] as AdbDevice);

    // Fusion uniquement entre transports DIFFÉRENTS (une entrée TCP avec une entrée
    // mDNS). Deux entrées de même transport sont forcément deux appareils distincts,
    // même modèle identique : ainsi le nombre affiché reste juste avec plusieurs
    // téléphones du même modèle sur le réseau.
    if (existing === undefined || existing.transport === device.transport) {
      seen.set(signature, result.length);
      result.push(device);
      continue;
    }

    // Doublon : garder l'entrée TCP, la seule sur laquelle `adb disconnect` agit.
    if (existing.transport !== 'tcp' && device.transport === 'tcp') {
      result[existingIndex as number] = device;
    }
  }

  return result;
}
