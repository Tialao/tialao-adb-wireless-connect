/**
 * Orchestration des deux flux d'association (QR et code à 6 chiffres).
 *
 * Le point délicat n'est pas l'enchaînement adb pair -> adb connect, c'est que le serveur
 * adb travaille CONTRE nous en parallèle : `ADB_MDNS_AUTO_CONNECT` vaut `adb-tls-connect`
 * par défaut, donc adb se connecte tout seul dès qu'il voit le service de connexion, et
 * ce service disparaît de la liste aussitôt consommé. On ne peut donc pas se contenter
 * d'attendre `_adb-tls-connect._tcp` : il faut aussi surveiller `adb devices`.
 *
 * Deuxième subtilité : le service d'association s'appelle `studio-xxxxxx` (notre nom) et
 * le service de connexion `adb-<serialUSB>-XXXXXX`. Aucun jeton commun. Le seul lien est
 * l'ADRESSE IP relevée sur le service d'association, confirmée par le `guid` que renvoie
 * `adb pair`.
 */

import type { Adb } from './adb.ts';
import { sleep } from './adb.ts';
import { Emitter } from './emitter.ts';
import type { Unsubscribe } from './emitter.ts';
import { TadbError, toTadbError } from './errors.ts';
import type { TadbErrorCode } from './errors.ts';
import { DEFAULT_DISCOVERY_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS, ensureMdnsAvailable, watchMdns } from './mdns.ts';
import { findConnectServiceForHost, findPairingService, formatHostPort } from './parse.ts';
import { buildQrPayload, generatePairingCredentials, renderQrSvgSafe } from './qr.ts';
import type {
  AdbDevice,
  HostPort,
  MdnsCheck,
  MdnsService,
  PairingCredentials,
} from './types.ts';

export type PairingState =
  | 'idle'
  | 'checking-mdns'
  | 'awaiting-scan'
  | 'pairing'
  | 'awaiting-connect'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'cancelled'
  | 'timeout';

const TERMINAL_STATES: readonly PairingState[] = [
  'connected',
  'failed',
  'cancelled',
  'timeout',
];

/**
 * Canal unique, union discriminée. Cette forme n'est pas un détail : elle EST le contrat
 * NDJSON du CLI (`tadb pair-qr --json`), donc un plugin écrit dans un autre langage lit
 * ces mêmes valeurs, une par ligne.
 */
export type PairingEvent =
  | { type: 'state'; from: PairingState; to: PairingState }
  | { type: 'qr-ready'; payload: string; credentials: PairingCredentials; svg?: string }
  | { type: 'mdns-status'; check: MdnsCheck }
  | { type: 'poll'; elapsedMs: number; remainingMs: number; serviceCount: number }
  | { type: 'pairing-service-found'; service: MdnsService }
  | { type: 'paired'; address: HostPort; guid?: string; usbSerial?: string }
  | { type: 'connect-service-found'; service: MdnsService }
  | { type: 'connected'; device: AdbDevice; address?: HostPort; viaAutoConnect: boolean }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; command?: string }
  | { type: 'error'; code: TadbErrorCode; message: string; hint?: string; fatal: boolean }
  | { type: 'done'; result: PairingResult };

export interface PairingResult {
  ok: boolean;
  endState: PairingState;
  device?: AdbDevice;
  address?: HostPort;
  credentials?: PairingCredentials;
  usbSerial?: string;
  viaAutoConnect?: boolean;
  error?: { code: TadbErrorCode; message: string; hint?: string };
}

export interface PairingSession {
  readonly state: PairingState;
  readonly credentials: PairingCredentials | undefined;
  on(listener: (event: PairingEvent) => void): Unsubscribe;
  cancel(reason?: string): void;
  /** Repli quand le mDNS ne découvre rien : l'utilisateur lit l'adresse sur le téléphone. */
  submitManualAddress(address: HostPort): void;
  readonly done: Promise<PairingResult>;
}

export interface QrPairingOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Inclure le rendu SVG dans l'événement `qr-ready` (inutile pour un affichage terminal). */
  includeSvg?: boolean;
  /** Autoriser un redémarrage du serveur adb si le backend mDNS ne répond pas. */
  allowServerRestart?: boolean;
  signal?: AbortSignal;
}

export interface CodePairingOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

const PAIR_RETRY_ATTEMPTS = 3;
const PAIR_RETRY_BACKOFF_MS = 500;

/* --------------------------------------------------------------------------------------- */

class Session implements PairingSession {
  private readonly emitter = new Emitter<PairingEvent>();
  private readonly controller = new AbortController();
  private current: PairingState = 'idle';
  private settle!: (result: PairingResult) => void;

  readonly done: Promise<PairingResult>;
  credentials: PairingCredentials | undefined;

  constructor() {
    this.done = new Promise<PairingResult>((resolve) => {
      this.settle = resolve;
    });
  }

  get state(): PairingState {
    return this.current;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  on(listener: (event: PairingEvent) => void): Unsubscribe {
    return this.emitter.on(listener);
  }

  emit(event: PairingEvent): void {
    this.emitter.emit(event);
  }

  transition(to: PairingState): void {
    if (this.current === to) return;
    const from = this.current;
    this.current = to;
    this.emit({ type: 'state', from, to });
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, command?: string): void {
    this.emit(command !== undefined ? { type: 'log', level, message, command } : { type: 'log', level, message });
  }

  cancel(reason = "Annulé par l'utilisateur."): void {
    if (TERMINAL_STATES.includes(this.current)) return;
    this.log('info', reason);
    this.controller.abort();
  }

  private manualAddress: ((address: HostPort) => void) | undefined;

  onManualAddress(handler: (address: HostPort) => void): void {
    this.manualAddress = handler;
  }

  submitManualAddress(address: HostPort): void {
    this.manualAddress?.(address);
  }

  finish(result: PairingResult): void {
    this.transition(result.endState);
    this.emit({ type: 'done', result });
    this.settle(result);
    this.controller.abort();
  }

  isCancelled(): boolean {
    return this.controller.signal.aborted;
  }
}

/* --------------------------------------------------------------------------------------- */

/** Attend qu'un appareil correspondant apparaisse, en surveillant mDNS ET `adb devices`. */
interface ConnectRaceOutcome {
  device: AdbDevice;
  address?: HostPort;
  viaAutoConnect: boolean;
}

/**
 * Cherche, parmi les appareils vus, celui qui correspond à l'association qu'on vient de
 * faire — par IP présente dans le serial, ou par serial USB issu du `guid`.
 */
function matchDevice(
  devices: readonly AdbDevice[],
  baseline: ReadonlySet<string>,
  host: string,
  usbSerial: string | undefined,
): AdbDevice | undefined {
  return devices.find((d) => {
    if (baseline.has(d.serial)) return false;
    if (d.state !== 'device') return false;
    if (d.host === host) return true;
    if (d.serial.includes(host)) return true;
    if (usbSerial && d.usbSerial === usbSerial) return true;
    return false;
  });
}

/**
 * Course à deux pistes après une association réussie :
 *   A — le service `_adb-tls-connect._tcp` apparaît en mDNS : on lance `adb connect` ;
 *   B — l'appareil apparaît dans `adb devices` sans qu'on ait rien fait : c'est
 *       l'auto-connect d'adb, et `adb connect` n'a alors pas lieu d'être.
 * La première piste qui aboutit gagne.
 */
async function raceToConnected(
  adb: Adb,
  session: Session,
  options: {
    host: string;
    usbSerial: string | undefined;
    baseline: ReadonlySet<string>;
    timeoutMs: number;
    pollIntervalMs: number;
  },
): Promise<ConnectRaceOutcome> {
  const { host, usbSerial, baseline, timeoutMs, pollIntervalMs } = options;
  const startedAt = Date.now();
  let connectAttempted = false;

  while (!session.isCancelled() && Date.now() - startedAt < timeoutMs) {
    // Piste B d'abord : si adb s'est déjà connecté seul, inutile de lancer un connect.
    const devices = await adb.devices();
    const found = matchDevice(devices, baseline, host, usbSerial);
    if (found) {
      const result: ConnectRaceOutcome = {
        device: found,
        viaAutoConnect: !connectAttempted,
      };
      if (found.host !== undefined && found.port !== undefined) {
        result.address = { host: found.host, port: found.port };
      }
      return result;
    }

    // Piste A : le service de connexion est visible, on tente le connect explicite.
    if (!connectAttempted) {
      const services = await adb.mdnsServices();
      const service = findConnectServiceForHost(services, host);
      if (service) {
        session.emit({ type: 'connect-service-found', service });
        session.transition('connecting');
        connectAttempted = true;

        const address: HostPort = { host: service.host, port: service.port };
        const connect = await adb.connect(address);
        if (connect.ok) {
          session.log(
            'info',
            connect.alreadyConnected
              ? `adb avait déjà connecté ${formatHostPort(address)} de lui-même.`
              : `Connecté à ${formatHostPort(address)}.`,
          );
        } else {
          // Non fatal : l'auto-connect d'adb a pu consommer le service entre-temps.
          // La piste B tranchera au tour suivant.
          session.log('warn', `adb connect a échoué (${connect.message}), poursuite de la surveillance.`);
          connectAttempted = false;
        }
      }
    }

    await sleep(pollIntervalMs);
  }

  if (session.isCancelled()) {
    throw new TadbError('CANCELLED', 'Association annulée.');
  }
  throw new TadbError(
    'CONNECT_FAILED',
    "L'appareil a bien été associé, mais n'est pas apparu comme connecté.",
  );
}

/** Exécute `adb pair`, avec quelques tentatives sur les échecs transitoires seulement. */
async function pairWithRetry(
  adb: Adb,
  session: Session,
  address: HostPort,
  password: string,
): Promise<{ address: HostPort; guid?: string; usbSerial?: string }> {
  let last = '';
  for (let attempt = 1; attempt <= PAIR_RETRY_ATTEMPTS; attempt += 1) {
    if (session.isCancelled()) throw new TadbError('CANCELLED', 'Association annulée.');

    const result = await adb.pair(address, password);
    if (result.ok) {
      const paired: { address: HostPort; guid?: string; usbSerial?: string } = {
        address: result.address ?? address,
      };
      if (result.guid) paired.guid = result.guid;
      if (result.usbSerial) paired.usbSerial = result.usbSerial;
      return paired;
    }

    last = result.message;

    // Un mot de passe erroné ne deviendra pas correct en réessayant.
    if (!result.retryable) {
      throw new TadbError('PAIR_WRONG_PASSWORD', result.message, { raw: result.raw });
    }

    session.log('warn', `Tentative d'association ${String(attempt)}/${String(PAIR_RETRY_ATTEMPTS)} échouée : ${result.message}`);
    if (attempt < PAIR_RETRY_ATTEMPTS) await sleep(PAIR_RETRY_BACKOFF_MS * attempt);
  }

  throw new TadbError('PAIR_FAILED', last || "L'association a échoué.");
}

function toFailure(session: Session, error: unknown, credentials?: PairingCredentials): PairingResult {
  const tadb = toTadbError(error);
  const endState: PairingState =
    tadb.code === 'CANCELLED' ? 'cancelled' : tadb.code === 'TIMEOUT' ? 'timeout' : 'failed';

  session.emit({
    type: 'error',
    code: tadb.code,
    message: tadb.message,
    ...(tadb.hint !== undefined ? { hint: tadb.hint } : {}),
    fatal: true,
  });

  return {
    ok: false,
    endState,
    ...(credentials ? { credentials } : {}),
    error: tadb.toJSON(),
  };
}

/* --------------------------------------------------------------------------------------- */
/* Flux QR                                                                                   */
/* --------------------------------------------------------------------------------------- */

export function startQrPairing(adb: Adb, options: QrPairingOptions = {}): PairingSession {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const session = new Session();

  options.signal?.addEventListener('abort', () => session.cancel(), { once: true });

  void (async () => {
    const credentials = generatePairingCredentials();
    session.credentials = credentials;

    // Laisser l'appelant s'abonner avant le premier événement. Sans cette césure,
    // `qr-ready` est émis pendant l'appel à startQrPairing() et se perd : personne
    // n'est encore branché sur la session, donc le webview n'afficherait aucun QR.
    await Promise.resolve();

    try {
      const payload = buildQrPayload(credentials);
      const svg = options.includeSvg === false ? undefined : await renderQrSvgSafe(payload);
      session.emit({
        type: 'qr-ready',
        payload,
        credentials,
        ...(svg !== undefined ? { svg } : {}),
      });

      session.transition('checking-mdns');
      const check = await ensureMdnsAvailable(adb, {
        allowRestart: options.allowServerRestart ?? true,
      });
      session.emit({ type: 'mdns-status', check });
      if (!check.available) {
        throw new TadbError(
          'MDNS_UNAVAILABLE',
          "Le backend mDNS d'adb ne répond pas ; la découverte automatique est impossible.",
        );
      }

      // Instantané AVANT toute association : sans lui, impossible de distinguer un
      // appareil auto-connecté par notre flux d'un appareil déjà branché.
      const baseline = new Set((await adb.devices()).map((d) => d.serial));

      session.transition('awaiting-scan');
      const address = await waitForPairingService(session, adb, credentials.serviceName, {
        timeoutMs,
        pollIntervalMs,
      });

      session.transition('pairing');
      const paired = await pairWithRetry(adb, session, address, credentials.password);
      session.emit({
        type: 'paired',
        address: paired.address,
        ...(paired.guid !== undefined ? { guid: paired.guid } : {}),
        ...(paired.usbSerial !== undefined ? { usbSerial: paired.usbSerial } : {}),
      });

      session.transition('awaiting-connect');
      const outcome = await raceToConnected(adb, session, {
        host: paired.address.host,
        usbSerial: paired.usbSerial,
        baseline,
        timeoutMs,
        pollIntervalMs,
      });

      session.emit({
        type: 'connected',
        device: outcome.device,
        ...(outcome.address !== undefined ? { address: outcome.address } : {}),
        viaAutoConnect: outcome.viaAutoConnect,
      });

      session.finish({
        ok: true,
        endState: 'connected',
        device: outcome.device,
        credentials,
        viaAutoConnect: outcome.viaAutoConnect,
        ...(outcome.address !== undefined ? { address: outcome.address } : {}),
        ...(paired.usbSerial !== undefined ? { usbSerial: paired.usbSerial } : {}),
      });
    } catch (error) {
      session.finish(toFailure(session, error, credentials));
    }
  })();

  return session;
}

/**
 * Attend l'apparition du service `_adb-tls-pairing._tcp` portant NOTRE nom de service,
 * ou une adresse saisie à la main si l'utilisateur perd patience.
 */
function waitForPairingService(
  session: Session,
  adb: Adb,
  serviceName: string,
  options: { timeoutMs: number; pollIntervalMs: number },
): Promise<HostPort> {
  return new Promise<HostPort>((resolve, reject) => {
    let settled = false;

    const watcher = watchMdns(adb, {
      intervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
      signal: session.signal,
    });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      watcher.stop();
      fn();
    };

    session.onManualAddress((address) => {
      session.log('info', `Adresse saisie manuellement : ${formatHostPort(address)}.`);
      finish(() => resolve(address));
    });

    session.signal.addEventListener(
      'abort',
      () => finish(() => reject(new TadbError('CANCELLED', 'Association annulée.'))),
      { once: true },
    );

    watcher.on((event) => {
      switch (event.type) {
        case 'tick': {
          session.emit({
            type: 'poll',
            elapsedMs: event.elapsedMs,
            remainingMs: event.remainingMs,
            serviceCount: event.services.length,
          });
          const service = findPairingService(event.services, serviceName);
          if (service) {
            session.emit({ type: 'pairing-service-found', service });
            finish(() => resolve({ host: service.host, port: service.port }));
          }
          break;
        }
        case 'silent':
          // Non fatal : on prévient, et l'utilisateur peut saisir l'adresse à la main.
          session.emit({
            type: 'error',
            code: event.error.code,
            message: event.error.message,
            ...(event.error.hint !== undefined ? { hint: event.error.hint } : {}),
            fatal: false,
          });
          break;
        case 'error':
          session.log('warn', `Sondage mDNS en échec : ${event.error.message}`);
          break;
        case 'timeout':
          finish(() =>
            reject(
              new TadbError(
                'MDNS_NO_SERVICES',
                `Aucun appareil n'a scanné le QR code dans le temps imparti (${String(Math.round(options.timeoutMs / 1000))} s).`,
              ),
            ),
          );
          break;
        default:
          break;
      }
    });
  });
}

/* --------------------------------------------------------------------------------------- */
/* Flux code à 6 chiffres                                                                    */
/* --------------------------------------------------------------------------------------- */

/**
 * Association par code : l'utilisateur lit l'adresse et le code sur le téléphone.
 * On entre directement en `pairing`, puis on rejoint exactement la même logique de
 * connexion que le flux QR.
 */
export function pairWithCode(
  adb: Adb,
  address: HostPort,
  code: string,
  options: CodePairingOptions = {},
): PairingSession {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const session = new Session();

  options.signal?.addEventListener('abort', () => session.cancel(), { once: true });

  void (async () => {
    // Meme raison que pour le flux QR : laisser l'appelant s'abonner avant d'emettre.
    await Promise.resolve();

    try {
      if (!/^\d{6}$/.test(code.trim())) {
        throw new TadbError(
          'INVALID_ARGUMENT',
          'Le code d’association doit comporter exactement 6 chiffres.',
        );
      }

      const baseline = new Set((await adb.devices()).map((d) => d.serial));

      session.transition('pairing');
      const paired = await pairWithRetry(adb, session, address, code.trim());
      session.emit({
        type: 'paired',
        address: paired.address,
        ...(paired.guid !== undefined ? { guid: paired.guid } : {}),
        ...(paired.usbSerial !== undefined ? { usbSerial: paired.usbSerial } : {}),
      });

      session.transition('awaiting-connect');
      const outcome = await raceToConnected(adb, session, {
        host: paired.address.host,
        usbSerial: paired.usbSerial,
        baseline,
        timeoutMs,
        pollIntervalMs,
      });

      session.emit({
        type: 'connected',
        device: outcome.device,
        ...(outcome.address !== undefined ? { address: outcome.address } : {}),
        viaAutoConnect: outcome.viaAutoConnect,
      });

      session.finish({
        ok: true,
        endState: 'connected',
        device: outcome.device,
        viaAutoConnect: outcome.viaAutoConnect,
        ...(outcome.address !== undefined ? { address: outcome.address } : {}),
        ...(paired.usbSerial !== undefined ? { usbSerial: paired.usbSerial } : {}),
      });
    } catch (error) {
      session.finish(toFailure(session, error));
    }
  })();

  return session;
}
