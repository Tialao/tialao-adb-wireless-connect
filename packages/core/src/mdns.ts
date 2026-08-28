/**
 * Découverte mDNS via adb lui-même (`adb mdns services`), plutôt qu'une pile mDNS Node.
 * Raison : c'est le serveur adb qui devra de toute façon joindre l'appareil ; interroger
 * sa propre vue évite les désaccords entre deux implémentations mDNS sur la même machine.
 */

import type { Adb } from './adb.ts';
import { Emitter } from './emitter.ts';
import type { Unsubscribe } from './emitter.ts';
import { TadbError, toTadbError } from './errors.ts';
import type { MdnsCheck, MdnsService } from './types.ts';

export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 120_000;

/** Nombre de sondages vides consécutifs avant de suggérer un problème réseau/pare-feu. */
const EMPTY_POLLS_BEFORE_HINT = 15;

export type MdnsWatchEvent =
  | { type: 'tick'; elapsedMs: number; remainingMs: number; services: MdnsService[] }
  | { type: 'added'; service: MdnsService }
  | { type: 'removed'; service: MdnsService }
  | { type: 'silent'; elapsedMs: number; error: TadbError }
  | { type: 'error'; error: TadbError }
  | { type: 'timeout' };

export interface MdnsWatchOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MdnsWatcher {
  on(listener: (event: MdnsWatchEvent) => void): Unsubscribe;
  stop(): void;
  readonly stopped: boolean;
}

function keyOf(service: MdnsService): string {
  return `${service.instance}|${service.type}|${service.host}:${String(service.port)}`;
}

/**
 * Sonde `adb mdns services` en boucle.
 *
 * La boucle est une CHAÎNE de `setTimeout` relancée après complétion, jamais un
 * `setInterval` : au démarrage du daemon, `adb mdns services` peut dépasser une seconde,
 * et un intervalle fixe empilerait les processus adb.
 */
export function watchMdns(adb: Adb, options: MdnsWatchOptions = {}): MdnsWatcher {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const emitter = new Emitter<MdnsWatchEvent>();
  const startedAt = Date.now();

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let emptyPolls = 0;
  let hintEmitted = false;
  let known = new Map<string, MdnsService>();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    options.signal?.removeEventListener('abort', stop);
    // On ne vide pas les abonnés : un dernier événement peut encore être en vol.
  };

  options.signal?.addEventListener('abort', stop, { once: true });

  const poll = async (): Promise<void> => {
    if (stopped) return;

    try {
      const services = await adb.mdnsServices();
      if (stopped) return;

      const next = new Map(services.map((s) => [keyOf(s), s]));

      for (const [key, service] of next) {
        if (!known.has(key)) emitter.emit({ type: 'added', service });
      }
      for (const [key, service] of known) {
        if (!next.has(key)) emitter.emit({ type: 'removed', service });
      }
      known = next;

      const elapsedMs = Date.now() - startedAt;
      emitter.emit({
        type: 'tick',
        elapsedMs,
        remainingMs: Math.max(0, timeoutMs - elapsedMs),
        services,
      });

      // Un mDNS muet ne renvoie JAMAIS d'erreur : il renvoie une liste vide, indéfiniment.
      // Sans ce signal, l'utilisateur attend 120 s devant un écran qui ne dit rien.
      emptyPolls = services.length === 0 ? emptyPolls + 1 : 0;
      if (emptyPolls >= EMPTY_POLLS_BEFORE_HINT && !hintEmitted) {
        hintEmitted = true;
        emitter.emit({
          type: 'silent',
          elapsedMs,
          error: new TadbError(
            'MDNS_NO_SERVICES',
            `Aucun service mDNS découvert après ${String(Math.round(elapsedMs / 1000))} s.`,
          ),
        });
      }
    } catch (error) {
      if (stopped) return;
      emitter.emit({ type: 'error', error: toTadbError(error) });
    }

    if (stopped) return;

    if (Date.now() - startedAt >= timeoutMs) {
      emitter.emit({ type: 'timeout' });
      stop();
      return;
    }

    // Surtout PAS de `unref()` ici : pendant l'attente, ce timer est la seule chose
    // qui maintienne la boucle d'événements en vie. Avec `unref()`, `tadb pair-qr`
    // sortait de lui-même juste après le premier sondage (Node quitte, code 13).
    // Le process peut malgré tout se terminer : le timeout et `stop()` libèrent le timer.
    timer = setTimeout(() => void poll(), intervalMs);
  };

  // Premier sondage immédiat : le service peut déjà être publié.
  void poll();

  return {
    on: (listener) => emitter.on(listener),
    stop,
    get stopped() {
      return stopped;
    },
  };
}

/**
 * Vérifie que le backend mDNS d'adb répond, et tente une réparation si non.
 *
 * Le redémarrage du serveur n'est tenté qu'ICI, avant le flux : couper le serveur adb
 * en pleine association casserait aussi les sessions adb des autres outils (Gradle,
 * Flutter, scrcpy).
 */
export async function ensureMdnsAvailable(
  adb: Adb,
  options: { allowRestart?: boolean } = {},
): Promise<MdnsCheck> {
  const first = await adb.mdnsCheck();
  if (first.available) return first;
  if (options.allowRestart === false) return first;

  // Sur les versions d'adb antérieures au backend Openscreen par défaut, forcer
  // ADB_MDNS_OPENSCREEN=1 débloque la découverte.
  await adb.restartServer({ openscreen: true });
  return adb.mdnsCheck();
}
