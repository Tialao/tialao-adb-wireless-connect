/**
 * Miroir d'écran, via le serveur scrcpy.
 *
 * Le protocole ci-dessous n'a pas été deviné : il a été observé octet par octet sur un
 * appareil réel (SM-A175F, Android 16, scrcpy-server 3.1). Voir CLAUDE.md pour la trace.
 *
 * Enchaînement :
 *  1. `adb push` du serveur sur l'appareil ;
 *  2. lancement via `app_process`, qui ouvre un socket local abstrait `scrcpy_<scid>` ;
 *  3. `adb forward` vers ce socket ;
 *  4. le client ouvre DEUX connexions — la première est le canal vidéo, la seconde le
 *     canal de contrôle. Le serveur n'émet rien tant que les deux ne sont pas établies.
 *
 * En-tête du canal vidéo :
 *     [0]        octet sentinelle (0x00)
 *     [1..64]    nom de l'appareil, 64 octets complétés par des NUL
 *     [65..68]   identifiant de codec en ASCII (« h264 »)
 *     [69..72]   largeur  (uint32 gros-boutiste)
 *     [73..76]   hauteur  (uint32 gros-boutiste)
 * puis, en boucle :
 *     [0..7]     pts et drapeaux (uint64) — bit 63 = paquet de configuration (SPS/PPS),
 *                                           bit 62 = image clé
 *     [8..11]    taille de la charge utile (uint32)
 *     [12..]     H.264 en Annex B (démarre bien par 00 00 00 01)
 */

import type { ChildProcess } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adb } from './adb.ts';
import { sleep } from './adb.ts';
import { Emitter } from './emitter.ts';
import type { Unsubscribe } from './emitter.ts';
import { TadbError, toTadbError } from './errors.ts';

/** Version du serveur embarqué. Le premier argument passé au serveur doit la refléter. */
export const SCRCPY_SERVER_VERSION = '3.1';

/**
 * Empreinte du binaire redistribué, identique au `scrcpy-server-v3.1` publié par
 * Genymobile. Elle est vérifiée avant chaque envoi sur l'appareil : ce fichier est
 * exécuté sur le téléphone de l'utilisateur, il n'a pas à être pris sur parole.
 */
export const SCRCPY_SERVER_SHA256 =
  '958f0944a62f23b1f33a16e9eb14844c1a04b882ca175a738c16d23cb22b86c0';

const DEVICE_JAR_PATH = '/data/local/tmp/tialao-scrcpy-server.jar';
const DEVICE_NAME_FIELD_LENGTH = 64;
const VIDEO_HEADER_LENGTH = 1 + DEVICE_NAME_FIELD_LENGTH + 4 + 4 + 4;
const FRAME_HEADER_LENGTH = 12;

/** Bit de poids fort du champ pts : le paquet porte la configuration (SPS/PPS). */
const PACKET_FLAG_CONFIG = 1n << 63n;
/** Bit 62 : image clé. */
const PACKET_FLAG_KEY_FRAME = 1n << 62n;

/* --------------------------------------------------------------------------------------- */
/* Messages de contrôle                                                                      */
/* --------------------------------------------------------------------------------------- */

const CONTROL_TYPE = {
  injectKeycode: 0,
  injectText: 1,
  injectTouch: 2,
  injectScroll: 3,
  backOrScreenOn: 4,
  expandNotificationPanel: 5,
  expandSettingsPanel: 6,
  collapsePanels: 7,
  getClipboard: 8,
  setClipboard: 9,
  rotateDevice: 11,
} as const;

/** Codes de touches Android utiles depuis un miroir. */
export const KEYCODE = {
  home: 3,
  back: 4,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  appSwitch: 187,
  enter: 66,
  del: 67,
  tab: 61,
  escape: 111,
  dpadUp: 19,
  dpadDown: 20,
  dpadLeft: 21,
  dpadRight: 22,
} as const;

export type KeyAction = 'down' | 'up';
export type TouchAction = 'down' | 'up' | 'move';

const KEY_ACTIONS: Record<KeyAction, number> = { down: 0, up: 1 };
const TOUCH_ACTIONS: Record<TouchAction, number> = { down: 0, up: 1, move: 2 };

/** Identifiant de pointeur arbitraire mais stable, pour une souris unique. */
const MOUSE_POINTER_ID = 0xffffffffffffffffn;

function keycodeMessage(action: KeyAction, keycode: number, metaState = 0): Buffer {
  const b = Buffer.alloc(14);
  b.writeUInt8(CONTROL_TYPE.injectKeycode, 0);
  b.writeUInt8(KEY_ACTIONS[action], 1);
  b.writeUInt32BE(keycode, 2);
  b.writeUInt32BE(0, 6); // répétitions
  b.writeUInt32BE(metaState, 10);
  return b;
}

function textMessage(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt8(CONTROL_TYPE.injectText, 0);
  b.writeUInt32BE(payload.length, 1);
  payload.copy(b, 5);
  return b;
}

function touchMessage(
  action: TouchAction,
  x: number,
  y: number,
  width: number,
  height: number,
  pressure = 1,
): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt8(CONTROL_TYPE.injectTouch, 0);
  b.writeUInt8(TOUCH_ACTIONS[action], 1);
  b.writeBigUInt64BE(MOUSE_POINTER_ID, 2);
  b.writeUInt32BE(Math.max(0, Math.round(x)), 10);
  b.writeUInt32BE(Math.max(0, Math.round(y)), 14);
  b.writeUInt16BE(width, 18);
  b.writeUInt16BE(height, 20);
  // Pression en virgule fixe sur 16 bits : 1.0 devient 0xFFFF.
  b.writeUInt16BE(action === 'up' ? 0 : Math.round(Math.min(1, pressure) * 0xffff), 22);
  b.writeUInt32BE(action === 'up' ? 1 : 0, 24); // bouton concerné par l'action
  b.writeUInt32BE(action === 'up' ? 0 : 1, 28); // boutons enfoncés (1 = principal)
  return b;
}

function scrollMessage(
  x: number,
  y: number,
  width: number,
  height: number,
  hScroll: number,
  vScroll: number,
): Buffer {
  const b = Buffer.alloc(21);
  b.writeUInt8(CONTROL_TYPE.injectScroll, 0);
  b.writeUInt32BE(Math.max(0, Math.round(x)), 1);
  b.writeUInt32BE(Math.max(0, Math.round(y)), 5);
  b.writeUInt16BE(width, 9);
  b.writeUInt16BE(height, 11);
  b.writeInt16BE(clampFixed16(hScroll), 13);
  b.writeInt16BE(clampFixed16(vScroll), 15);
  b.writeUInt32BE(0, 17); // boutons
  return b;
}

/** Convertit un défilement en virgule fixe signée sur 16 bits. */
function clampFixed16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.round(clamped * 0x7fff);
}

function simpleMessage(type: number): Buffer {
  return Buffer.from([type]);
}

/* --------------------------------------------------------------------------------------- */
/* Identification du codec                                                                   */
/* --------------------------------------------------------------------------------------- */

/**
 * Dérive la chaîne de codec attendue par WebCodecs à partir du SPS.
 *
 * `VideoDecoder.configure()` exige une chaîne du type `avc1.64001f`, dont les trois
 * octets sont pris juste après l'en-tête NAL du SPS : profile_idc, contraintes,
 * level_idc. Observé sur SM-A175F : `00 00 00 01 67 64 00 1f` donne `avc1.64001f`.
 *
 * Renvoie `undefined` si le paquet ne contient pas de SPS exploitable ; l'appelant
 * peut alors se rabattre sur une valeur par défaut.
 */
export function avcCodecFromConfig(data: Uint8Array): string | undefined {
  // Parcours des unités NAL en Annex B, à la recherche du SPS (type 7).
  for (let i = 0; i + 4 < data.length; i += 1) {
    const isStartCode4 =
      data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    const isStartCode3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (!isStartCode4 && !isStartCode3) continue;

    const nalStart = i + (isStartCode4 ? 4 : 3);
    const header = data[nalStart];
    if (header === undefined || (header & 0x1f) !== 7) continue;

    const profile = data[nalStart + 1];
    const constraints = data[nalStart + 2];
    const level = data[nalStart + 3];
    if (profile === undefined || constraints === undefined || level === undefined) return undefined;

    const hex = (v: number): string => v.toString(16).padStart(2, '0');
    return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
  }
  return undefined;
}

/* --------------------------------------------------------------------------------------- */
/* Session                                                                                   */
/* --------------------------------------------------------------------------------------- */

export interface ScrcpyVideoFrame {
  /** Charge utile H.264 en Annex B. */
  data: Uint8Array;
  /** Paquet de configuration (SPS/PPS) : à fournir au décodeur avant toute image. */
  isConfig: boolean;
  isKeyFrame: boolean;
  /** Horodatage en microsecondes, ou undefined pour un paquet de configuration. */
  ptsUs?: bigint;
}

export type ScrcpyEvent =
  | { type: 'starting'; message: string }
  | { type: 'ready'; deviceName: string; codec: string; width: number; height: number }
  | { type: 'frame'; frame: ScrcpyVideoFrame }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; error: TadbError }
  | { type: 'closed'; reason: string };

export interface ScrcpyOptions {
  /** Appareil ciblé. Requis dès qu'il y en a plusieurs. */
  serial?: string;
  /**
   * Plus grande dimension de l'image encodée. Réduire allège l'encodage et le réseau ;
   * l'affichage, lui, est redimensionné librement côté interface.
   */
  maxSize?: number;
  /** Débit vidéo visé, en bits par seconde. */
  bitRate?: number;
  maxFps?: number;
  /** Chemin d'un `scrcpy-server` de remplacement. */
  serverPath?: string;
  /** Désactive le canal de contrôle : miroir en lecture seule. */
  readOnly?: boolean;
  /** Éteint l'écran physique du téléphone pendant le miroir. */
  turnScreenOff?: boolean;
  /** Empêche la mise en veille pendant le miroir. */
  stayAwake?: boolean;
}

export interface ScrcpySession {
  on(listener: (event: ScrcpyEvent) => void): Unsubscribe;
  readonly deviceName: string | undefined;
  readonly width: number;
  readonly height: number;
  /** Envoie un appui ou un relâchement de touche. */
  key(action: KeyAction, keycode: number, metaState?: number): void;
  /** Appui puis relâchement immédiats. */
  tapKey(keycode: number): void;
  /** Coordonnées exprimées dans le repère de l'image encodée. */
  touch(action: TouchAction, x: number, y: number, pressure?: number): void;
  scroll(x: number, y: number, hScroll: number, vScroll: number): void;
  text(value: string): void;
  expandNotifications(): void;
  rotate(): void;
  stop(reason?: string): Promise<void>;
  readonly stopped: boolean;
}

/**
 * Chemin du `scrcpy-server` embarqué dans le paquet.
 *
 * ATTENTION : ne fonctionne que si ce module s'exécute en ESM. Une fois bundlé en
 * CommonJS — ce que fait l'extension VS Code — `import.meta.url` est vide et la
 * résolution échoue. Tout hôte bundlé doit donc passer `serverPath` explicitement.
 */
export function bundledServerPath(): string {
  const here = import.meta.url;
  if (!here) {
    throw new TadbError(
      'ADB_EXEC_FAILED',
      "Le chemin du serveur scrcpy ne peut pas être déduit dans ce contexte.",
      { hint: "L'hôte doit fournir `serverPath` explicitement." },
    );
  }
  // `vendor/` est publié à côté de `dist/`, d'où la remontée d'un niveau.
  return join(dirname(fileURLToPath(here)), '..', 'vendor', 'scrcpy-server');
}

/**
 * Vérifie l'empreinte du serveur avant de l'envoyer sur l'appareil.
 * Ce fichier s'exécute sur le téléphone de l'utilisateur : on ne le prend pas sur parole.
 */
async function readVerifiedServer(path: string): Promise<Buffer> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (error) {
    throw new TadbError('ADB_EXEC_FAILED', `Serveur scrcpy introuvable : ${path}`, {
      cause: error,
      hint: "Réinstallez l'extension, ou indiquez un scrcpy-server valide dans les réglages.",
    });
  }

  const digest = createHash('sha256').update(data).digest('hex');
  if (digest !== SCRCPY_SERVER_SHA256) {
    throw new TadbError(
      'ADB_EXEC_FAILED',
      "L'empreinte du serveur scrcpy ne correspond pas à la version attendue.",
      {
        hint: `Attendu ${SCRCPY_SERVER_SHA256}, obtenu ${digest}. Le fichier a été modifié ou remplacé : il ne sera pas envoyé sur l'appareil.`,
      },
    );
  }
  return data;
}

/** Lit le port réellement alloué par `adb forward tcp:0`. */
function parseForwardedPort(stdout: string): number | null {
  const port = Number(stdout.trim().split(/\r?\n/).pop());
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Identifiant de session, sur 8 chiffres hexadécimaux.
 *
 * Le serveur le relit avec `Integer.parseInt(scid, 16)`, c'est-à-dire un entier SIGNÉ
 * 32 bits : toute valeur dont le premier chiffre hexadécimal dépasse 7 vaut plus de
 * 2^31 - 1 et fait échouer le démarrage sur un `NumberFormatException`. Le tirage est
 * donc borné à 2^31 - 1, et non à 2^32.
 *
 * Le bug ne se manifestait qu'une fois sur deux, d'où sa découverte tardive.
 */
export function generateScid(rng: (maxExclusive: number) => number = randomInt): string {
  return rng(0x7fffffff).toString(16).padStart(8, '0');
}

export async function startMirror(adb: Adb, options: ScrcpyOptions = {}): Promise<ScrcpySession> {
  const emitter = new Emitter<ScrcpyEvent>();
  const serverPath = options.serverPath ?? bundledServerPath();
  const scid = generateScid();

  const emit = (event: ScrcpyEvent): void => emitter.emit(event);
  emit({ type: 'starting', message: 'Vérification du serveur…' });

  await readVerifiedServer(serverPath);

  // Le serial vient d'`adb devices`, mais il traverse une ligne `adb shell` : on
  // n'accepte que la forme qu'adb produit réellement.
  const serial = options.serial;
  if (serial !== undefined && !/^[A-Za-z0-9._:%-]{1,128}$/.test(serial)) {
    throw new TadbError('INVALID_ARGUMENT', `Identifiant d'appareil refusé : ${serial}`);
  }
  const target = serial ? ['-s', serial] : [];

  // Tout passe par la façade `Adb` : elle seule connaît l'adaptation des shims
  // Windows, les timeouts et la journalisation. Lancer un processus en direct ici
  // reviendrait à contourner ces garanties.
  const run = async (args: readonly string[]): Promise<{ stdout: string }> => {
    const result = await adb.raw([...target, ...args], { timeoutMs: 30_000 });
    if (result.timedOut) {
      throw new TadbError('ADB_TIMEOUT', `La commande adb ${args[0] ?? ''} n'a pas répondu.`);
    }
    return { stdout: result.stdout };
  };

  emit({ type: 'starting', message: "Envoi du serveur sur l'appareil…" });
  await run(['push', serverPath, DEVICE_JAR_PATH]);

  // Revalidation dans le cœur : ces valeurs sont concaténées dans la chaîne passée à
  // `adb shell`. On ne se repose pas sur la validation de l'appelant.
  const safeInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
  };
  const maxSize = safeInt(options.maxSize, 1280, 320, 3840);
  const bitRate = safeInt(options.bitRate, 8_000_000, 100_000, 100_000_000);
  const maxFps = options.maxFps === undefined ? undefined : safeInt(options.maxFps, 0, 1, 240);

  const serverArgs = [
    `CLASSPATH=${DEVICE_JAR_PATH}`,
    'app_process',
    '/',
    'com.genymobile.scrcpy.Server',
    SCRCPY_SERVER_VERSION,
    `scid=${scid}`,
    'log_level=info',
    'audio=false',
    'video=true',
    `control=${options.readOnly ? 'false' : 'true'}`,
    'tunnel_forward=true',
    'video_codec=h264',
    `max_size=${String(maxSize)}`,
    `video_bit_rate=${String(bitRate)}`,
    ...(maxFps ? [`max_fps=${String(maxFps)}`] : []),
    ...(options.turnScreenOff ? ['turn_screen_off=true'] : []),
    ...(options.stayAwake ? ['stay_awake=true'] : []),
  ];

  emit({ type: 'starting', message: 'Démarrage du serveur…' });
  const server: ChildProcess = await adb.spawn([...target, 'shell', serverArgs.join(' ')]);

  const recentServerOutput: string[] = [];
  const serverLog = (data: unknown, level: 'info' | 'warn'): void => {
    const message = String(data).trim();
    if (!message) return;
    // Le serveur explique presque toujours son refus sur stderr : ces lignes sont
    // la seule information utile quand la connexion tombe sans erreur socket.
    recentServerOutput.push(message);
    if (recentServerOutput.length > 6) recentServerOutput.shift();
    emit({ type: 'log', level, message });
  };
  server.stdout?.on('data', (d) => serverLog(d, 'info'));
  server.stderr?.on('data', (d) => serverLog(d, 'warn'));

  // Laisser au serveur le temps d'ouvrir son socket avant de tenter le tunnel.
  await sleep(1200);

  const { stdout } = await run(['forward', 'tcp:0', `localabstract:scrcpy_${scid}`]);
  const port = parseForwardedPort(stdout);
  if (port === null) {
    server.kill();
    throw new TadbError('ADB_EXEC_FAILED', "Le tunnel adb n'a pas pu être établi.");
  }

  const openSocket = (): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => resolve(socket));
      socket.once('error', reject);
    });

  let videoSocket: Socket;
  let controlSocket: Socket | undefined;
  try {
    // L'ordre compte : la première connexion est le canal vidéo, la seconde le contrôle.
    videoSocket = await openSocket();
    if (!options.readOnly) controlSocket = await openSocket();
  } catch (error) {
    server.kill();
    await run(['forward', '--remove', `tcp:${String(port)}`]).catch(() => undefined);
    throw new TadbError('ADB_EXEC_FAILED', "Connexion au serveur scrcpy impossible.", {
      cause: error,
    });
  }

  const state = {
    deviceName: undefined as string | undefined,
    width: 0,
    height: 0,
    stopped: false,
  };

  /* --- Analyse du flux vidéo ------------------------------------------------------- */

  // Typage explicite : `subarray()` renvoie un Buffer<ArrayBufferLike>, que le type
  // inféré depuis `Buffer.alloc()` (Buffer<ArrayBuffer>) n'accepte pas en réassignation.
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let headerRead = false;

  videoSocket.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    if (!headerRead) {
      if (buffer.length < VIDEO_HEADER_LENGTH) return;
      const name = buffer
        .subarray(1, 1 + DEVICE_NAME_FIELD_LENGTH)
        .toString('utf8')
        .replace(/\0+$/, '');
      const codec = buffer.subarray(65, 69).toString('latin1');
      state.deviceName = name;
      state.width = buffer.readUInt32BE(69);
      state.height = buffer.readUInt32BE(73);
      buffer = buffer.subarray(VIDEO_HEADER_LENGTH);
      headerRead = true;
      emit({ type: 'ready', deviceName: name, codec, width: state.width, height: state.height });
    }

    // Un même paquet TCP peut contenir plusieurs trames, ou une trame partielle.
    for (;;) {
      if (buffer.length < FRAME_HEADER_LENGTH) return;
      const size = buffer.readUInt32BE(8);
      if (buffer.length < FRAME_HEADER_LENGTH + size) return;

      const ptsAndFlags = buffer.readBigUInt64BE(0);
      const isConfig = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n;
      const isKeyFrame = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
      const data = new Uint8Array(
        buffer.subarray(FRAME_HEADER_LENGTH, FRAME_HEADER_LENGTH + size),
      );

      const frame: ScrcpyVideoFrame = { data, isConfig, isKeyFrame };
      if (!isConfig) frame.ptsUs = ptsAndFlags & ~(PACKET_FLAG_CONFIG | PACKET_FLAG_KEY_FRAME);
      emit({ type: 'frame', frame });

      buffer = buffer.subarray(FRAME_HEADER_LENGTH + size);
    }
  });

  /* --- Fin de session -------------------------------------------------------------- */

  const stop = async (reason = 'Miroir arrêté.'): Promise<void> => {
    if (state.stopped) return;
    state.stopped = true;
    videoSocket.destroy();
    controlSocket?.destroy();
    server.kill();
    await run(['forward', '--remove', `tcp:${String(port)}`]).catch(() => undefined);
    emit({ type: 'closed', reason });
  };

  videoSocket.on('error', (error) => {
    if (!state.stopped) emit({ type: 'error', error: toTadbError(error) });
  });
  const withServerOutput = (reason: string): string => {
    const tail = recentServerOutput.join(' · ');
    return tail ? `${reason} — le serveur a signalé : ${tail}` : reason;
  };

  videoSocket.on('close', () =>
    void stop(withServerOutput('Le flux vidéo a été interrompu.')),
  );
  server.on('exit', (code) =>
    void stop(withServerOutput(`Le serveur scrcpy s'est arrêté (code ${String(code)}).`)),
  );

  const send = (message: Buffer): void => {
    if (state.stopped || !controlSocket || controlSocket.destroyed) return;
    controlSocket.write(message);
  };

  return {
    on: (listener) => emitter.on(listener),
    get deviceName() {
      return state.deviceName;
    },
    get width() {
      return state.width;
    },
    get height() {
      return state.height;
    },
    get stopped() {
      return state.stopped;
    },
    key: (action, keycode, metaState) => send(keycodeMessage(action, keycode, metaState)),
    tapKey: (keycode) => {
      send(keycodeMessage('down', keycode));
      send(keycodeMessage('up', keycode));
    },
    touch: (action, x, y, pressure) =>
      send(touchMessage(action, x, y, state.width, state.height, pressure)),
    scroll: (x, y, hScroll, vScroll) =>
      send(scrollMessage(x, y, state.width, state.height, hScroll, vScroll)),
    text: (value) => send(textMessage(value)),
    expandNotifications: () => send(simpleMessage(CONTROL_TYPE.expandNotificationPanel)),
    rotate: () => send(simpleMessage(CONTROL_TYPE.rotateDevice)),
    stop,
  };
}
