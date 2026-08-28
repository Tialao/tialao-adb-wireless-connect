/**
 * Binaire `tadb`.
 *
 * C'est le SEUL fichier du cœur autorisé à écrire sur la sortie standard (règle ESLint
 * `no-console` ailleurs). Cette contrainte n'est pas cosmétique : elle garantit qu'en
 * mode `--json`, stdout ne contient que du JSON, et donc qu'un plugin écrit dans un
 * autre langage peut parser la sortie sans filtrage.
 *
 * Deux formes de sortie JSON :
 *  - commandes ponctuelles : UN objet, une ligne ;
 *  - commandes streamantes (`pair-qr`, `mdns --watch`) : NDJSON, un événement par ligne,
 *    terminé par `{"type":"done",...}`.
 */

import { Adb, resolveAdbPath } from './adb.ts';
import { EXIT_CODES, TadbError, exitCodeFor, toTadbError } from './errors.ts';
import { watchMdns } from './mdns.ts';
import { dedupeDevices, formatHostPort, parseHostPort } from './parse.ts';
import { pairWithCode, startQrPairing } from './pairing.ts';
import type { PairingEvent } from './pairing.ts';
import { buildQrPayload, generatePairingCredentials, renderQrTerminal } from './qr.ts';
import { loadHistory, touchConnected, upsertDevice } from './storage.ts';
import type { AdbDevice, HostPort } from './types.ts';

const SCHEMA_VERSION = 1;

/* --------------------------------------------------------------------------------------- */
/* Sortie                                                                                    */
/* --------------------------------------------------------------------------------------- */

interface Cli {
  json: boolean;
  pretty: boolean;
  color: boolean;
}

let cli: Cli = { json: false, pretty: false, color: true };

/** Une écriture qui ne fait pas planter `tadb ... | head -1`. */
function write(text: string): void {
  try {
    process.stdout.write(text);
  } catch {
    /* flux fermé : rien à signaler */
  }
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(EXIT_CODES.ok);
});

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[36m',
} as const;

function paint(text: string, ...codes: Array<keyof typeof ANSI>): string {
  if (!cli.color) return text;
  return codes.map((c) => ANSI[c]).join('') + text + ANSI.reset;
}

/** Sortie lisible par un humain. Supprimée — pas redirigée — en mode --json. */
function say(text = ''): void {
  if (cli.json) return;
  write(text + '\n');
}

function box(title: string, lines: string[]): void {
  if (cli.json) return;
  const width = Math.max(title.length + 2, ...lines.map((l) => stripAnsi(l).length + 2), 40);
  const pad = (l: string): string => l + ' '.repeat(Math.max(0, width - stripAnsi(l).length));
  say(paint(`┌─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 2))}┐`, 'dim'));
  for (const line of lines) say(`${paint('│', 'dim')} ${pad(line)}${paint('│', 'dim')}`);
  say(paint(`└${'─'.repeat(width + 1)}┘`, 'dim'));
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

/** Émet une valeur JSON, une par ligne (NDJSON pour les commandes streamantes). */
function emit(value: unknown): void {
  write(JSON.stringify(value, null, cli.pretty ? 2 : undefined) + '\n');
}

function ok(command: string, data: unknown): void {
  if (cli.json) emit({ schemaVersion: SCHEMA_VERSION, ok: true, command, data });
}

function fail(command: string, error: TadbError): never {
  if (cli.json) {
    emit({ schemaVersion: SCHEMA_VERSION, ok: false, command, error: error.toJSON() });
  } else {
    say();
    say(`${paint('✖', 'red', 'bold')} ${paint(error.message, 'bold')}`);
    if (error.hint) say(`  ${paint('→', 'dim')} ${error.hint}`);
  }
  process.exit(exitCodeFor(error.code));
}

/* --------------------------------------------------------------------------------------- */
/* Analyse des arguments — maison, pour n'avoir aucune dépendance                             */
/* --------------------------------------------------------------------------------------- */

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const VALUE_FLAGS = new Set(['adb', 'timeout', 'interval', 'port', 'serial', 'mode']);

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let command = '';
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (onlyPositionals) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new TadbError('INVALID_ARGUMENT', `L'option --${body} attend une valeur.`);
        }
        flags.set(body, next);
        i += 1;
        continue;
      }
      flags.set(body, true);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const short: Record<string, string> = { h: 'help', v: 'version', j: 'json' };
      const name = short[arg.slice(1)];
      if (!name) throw new TadbError('INVALID_ARGUMENT', `Option inconnue : ${arg}`);
      flags.set(name, true);
      continue;
    }

    if (!command) command = arg;
    else positionals.push(arg);
  }

  return { command, positionals, flags };
}

function numberFlag(flags: ParsedArgs['flags'], name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined || typeof raw === 'boolean') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TadbError('INVALID_ARGUMENT', `L'option --${name} attend un nombre positif.`);
  }
  return value;
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const raw = flags.get(name);
  return typeof raw === 'string' ? raw : undefined;
}

function requireAddress(value: string | undefined, what: string): HostPort {
  if (!value) throw new TadbError('INVALID_ARGUMENT', `${what} (forme ip:port).`);
  const address = parseHostPort(value);
  if (!address) {
    throw new TadbError('INVALID_ARGUMENT', `« ${value} » n'est pas une adresse ip:port valide.`);
  }
  return address;
}

/* --------------------------------------------------------------------------------------- */
/* Affichage                                                                                 */
/* --------------------------------------------------------------------------------------- */

function describeDevice(device: AdbDevice): string {
  const name = device.model ?? device.serial;
  const badge =
    device.state === 'device'
      ? paint('●', 'green')
      : device.state === 'offline'
        ? paint('●', 'yellow')
        : paint('●', 'red');
  const where =
    device.transport === 'usb' ? 'USB' : device.transport === 'tcp' ? 'Wi-Fi' : 'Wi-Fi (mDNS)';
  return `${badge} ${paint(name, 'bold')} ${paint(`— ${where} — ${device.serial} [${device.state}]`, 'dim')}`;
}

const HELP = `
${paint('TIALAO ADB Wireless Connect', 'bold')} — connexion ADB sans fil, sans Android Studio.

${paint('Usage', 'bold')}
  tadb <commande> [options]

${paint('Commandes', 'bold')}
  pair-qr                 Affiche un QR code, attend le scan, associe puis connecte
  pair <ip:port> <code>   Associe avec un code à 6 chiffres lu sur le téléphone
  connect [ip:port]       Connecte un appareil (sans argument : le dernier associé)
  disconnect [ip:port]    Déconnecte un appareil (sans argument : tous)
  devices                 Liste les appareils vus par adb
  mdns [--watch]          Liste les services mDNS découverts
  tcpip [--port 5555]     Bascule un appareil USB en TCP/IP (Android ≤ 10)
  restart                 Redémarre le serveur adb
  history                 Liste les appareils déjà associés
  qr                      Génère un QR d'association sans lancer le flux
  help, version

${paint('Options', 'bold')}
  --json                  Sortie JSON (NDJSON pour pair-qr et mdns --watch)
  --pretty                Indente le JSON (débogage humain)
  --no-color              Désactive les couleurs
  --adb <chemin>          Chemin vers le binaire adb
  --timeout <secondes>    Timeout de découverte (défaut 120)
  --interval <ms>         Intervalle de sondage mDNS (défaut 1000)
  --serial <serial>       Cible un appareil précis (tcpip)
  --port <port>           Port pour tcpip (défaut 5555)
  --mode <auto|compact|wide>  Rendu du QR dans le terminal

${paint('Exemples', 'bold')}
  tadb pair-qr
  tadb pair 192.168.1.42:41234 123456
  tadb devices --json
  tadb mdns --watch --json
`;

/* --------------------------------------------------------------------------------------- */
/* Commandes                                                                                 */
/* --------------------------------------------------------------------------------------- */

function makeAdb(flags: ParsedArgs['flags']): Adb {
  const adbPath = stringFlag(flags, 'adb');
  const verbose = flags.get('verbose') === true;
  return new Adb({
    ...(adbPath !== undefined ? { adbPath } : {}),
    ...(verbose && !cli.json
      ? {
          onLog: (entry) => {
            say(paint(`  $ ${entry.command}  (${String(entry.durationMs)} ms)`, 'dim'));
          },
        }
      : {}),
  });
}

async function commandDevices(adb: Adb): Promise<void> {
  const devices = await adb.devices();
  // Le JSON expose la liste BRUTE d'adb : un consommateur machine doit voir ce
  // qu'adb voit. Seul l'affichage humain regroupe les doublons TCP/mDNS.
  ok('devices', { devices });
  if (devices.length === 0) {
    say(paint('Aucun appareil connecté.', 'dim'));
    return;
  }
  say();
  for (const device of dedupeDevices(devices)) say('  ' + describeDevice(device));
  say();
}

async function commandMdns(adb: Adb, flags: ParsedArgs['flags']): Promise<void> {
  if (flags.get('watch') !== true) {
    const services = await adb.mdnsServices();
    ok('mdns', { services });
    if (services.length === 0) say(paint('Aucun service mDNS découvert.', 'dim'));
    for (const s of services) say(`  ${s.instance}  ${paint(s.type, 'dim')}  ${s.host}:${String(s.port)}`);
    return;
  }

  const timeoutMs = numberFlag(flags, 'timeout', 120) * 1000;
  const intervalMs = numberFlag(flags, 'interval', 1000);

  await new Promise<void>((resolve) => {
    const watcher = watchMdns(adb, { timeoutMs, intervalMs });
    watcher.on((event) => {
      if (cli.json) {
        if (event.type !== 'tick') emit(event);
      } else if (event.type === 'added') {
        say(`${paint('+', 'green')} ${event.service.instance}  ${paint(event.service.type, 'dim')}  ${event.service.host}:${String(event.service.port)}`);
      } else if (event.type === 'removed') {
        say(`${paint('-', 'yellow')} ${event.service.instance}`);
      } else if (event.type === 'silent') {
        say(paint(`  ${event.error.message}`, 'yellow'));
        if (event.error.hint) say(paint(`  → ${event.error.hint}`, 'dim'));
      }
      if (event.type === 'timeout') resolve();
    });
    process.on('SIGINT', () => {
      watcher.stop();
      resolve();
    });
  });
}

async function commandPairQr(adb: Adb, flags: ParsedArgs['flags']): Promise<void> {
  const timeoutMs = numberFlag(flags, 'timeout', 120) * 1000;
  const intervalMs = numberFlag(flags, 'interval', 1000);
  const mode = stringFlag(flags, 'mode');

  const session = startQrPairing(adb, {
    timeoutMs,
    pollIntervalMs: intervalMs,
    // Le SVG n'a aucun intérêt dans un terminal : on ne le calcule pas.
    includeSvg: false,
  });

  let lastRemaining = -1;

  session.on((event: PairingEvent) => {
    if (cli.json) {
      emit(event);
      return;
    }

    switch (event.type) {
      case 'qr-ready':
        void (async () => {
          say();
          say(await renderQrTerminal(event.payload, {
            ...(mode === 'compact' || mode === 'wide' || mode === 'auto' ? { mode } : {}),
          }));
          box('Associer un appareil', [
            `Sur le téléphone : ${paint('Paramètres → Options pour les développeurs', 'bold')}`,
            `  → Débogage sans fil → ${paint('Associer avec un code QR', 'bold')}`,
            '',
            `Service  : ${paint(event.credentials.serviceName, 'blue')}`,
            `Mot de passe : ${paint(event.credentials.password, 'blue')}`,
          ]);
          say(paint('En attente du scan…  (Ctrl+C pour annuler)', 'dim'));
        })();
        break;
      case 'poll': {
        const remaining = Math.ceil(event.remainingMs / 1000);
        if (remaining !== lastRemaining && remaining % 10 === 0) {
          lastRemaining = remaining;
          say(paint(`  … ${String(remaining)} s restantes`, 'dim'));
        }
        break;
      }
      case 'pairing-service-found':
        say(`${paint('✓', 'green')} QR scanné — appareil détecté sur ${event.service.host}`);
        break;
      case 'paired':
        say(`${paint('✓', 'green')} Association réussie avec ${formatHostPort(event.address)}`);
        break;
      case 'connected':
        say(
          `${paint('✓', 'green')} ${paint('Connecté', 'bold')} : ${describeDevice(event.device)}` +
            (event.viaAutoConnect ? paint('  (connexion automatique d’adb)', 'dim') : ''),
        );
        break;
      case 'error':
        if (!event.fatal) {
          say(paint(`  ! ${event.message}`, 'yellow'));
          if (event.hint) say(paint(`    → ${event.hint}`, 'dim'));
        }
        break;
      case 'log':
        if (event.level === 'warn' || event.level === 'error') {
          say(paint(`  ! ${event.message}`, 'yellow'));
        }
        break;
      default:
        break;
    }
  });

  process.on('SIGINT', () => session.cancel());

  const result = await session.done;
  if (!result.ok) {
    fail('pair-qr', new TadbError(result.error?.code ?? 'PAIR_FAILED', result.error?.message ?? 'Échec.', {
      ...(result.error?.hint !== undefined ? { hint: result.error.hint } : {}),
    }));
  }
  await rememberDevice(result.device, result.address, result.usbSerial);
}

async function commandPairCode(adb: Adb, positionals: string[], flags: ParsedArgs['flags']): Promise<void> {
  const address = requireAddress(positionals[0], "L'adresse d'association est requise");
  const code = positionals[1];
  if (!code) {
    throw new TadbError('INVALID_ARGUMENT', 'Le code à 6 chiffres est requis.');
  }

  const session = pairWithCode(adb, address, code, {
    timeoutMs: numberFlag(flags, 'timeout', 120) * 1000,
    pollIntervalMs: numberFlag(flags, 'interval', 1000),
  });

  session.on((event) => {
    if (cli.json) {
      emit(event);
      return;
    }
    if (event.type === 'paired') say(`${paint('✓', 'green')} Association réussie.`);
    if (event.type === 'connected') say(`${paint('✓', 'green')} Connecté : ${describeDevice(event.device)}`);
  });

  const result = await session.done;
  if (!result.ok) {
    fail('pair', new TadbError(result.error?.code ?? 'PAIR_FAILED', result.error?.message ?? 'Échec.', {
      ...(result.error?.hint !== undefined ? { hint: result.error.hint } : {}),
    }));
  }
  await rememberDevice(result.device, result.address, result.usbSerial);
}

/** Mémorise l'appareil, sans jamais faire échouer la commande si l'écriture rate. */
async function rememberDevice(
  device: AdbDevice | undefined,
  address: HostPort | undefined,
  usbSerial: string | undefined,
): Promise<void> {
  if (!device) return;
  try {
    const id = usbSerial ?? device.usbSerial ?? address?.host ?? device.serial;
    await upsertDevice({
      id,
      label: device.model ?? device.serial,
      ...(device.model !== undefined ? { model: device.model } : {}),
      ...(usbSerial ?? device.usbSerial ? { usbSerial: usbSerial ?? device.usbSerial } : {}),
      ...(address ? { lastSeenIp: address.host, lastPort: address.port } : {}),
    });
  } catch {
    say(paint("  ! L'appareil n'a pas pu être ajouté à l'historique.", 'yellow'));
  }
}

async function commandConnect(adb: Adb, positionals: string[]): Promise<void> {
  let address: HostPort | undefined;

  if (positionals[0]) {
    address = requireAddress(positionals[0], "L'adresse est requise");
  } else {
    // Sans argument : redécouvrir le dernier appareil connu. On ne réutilise JAMAIS le
    // port mémorisé — le téléphone en tire un nouveau à chaque redémarrage.
    const history = await loadHistory();
    const last = history[0];
    if (!last) {
      throw new TadbError('NO_DEVICE', "Aucun appareil dans l'historique ; précisez une adresse ip:port.");
    }
    say(paint(`Recherche de ${last.label} en mDNS…`, 'dim'));
    const services = await adb.mdnsServices();
    const match = services.find(
      (s) => s.type === '_adb-tls-connect._tcp' && (!last.lastSeenIp || s.host === last.lastSeenIp),
    );
    if (!match) {
      throw new TadbError(
        'NO_DEVICE',
        `${last.label} n'a pas été retrouvé en mDNS.`,
        {
          hint: "Vérifiez que le Débogage sans fil est actif sur le téléphone et que les deux appareils sont sur le même Wi-Fi, ou passez l'adresse ip:port en argument.",
        },
      );
    }
    address = { host: match.host, port: match.port };
  }

  const result = await adb.connect(address);
  ok('connect', { result });
  if (!result.ok) {
    throw new TadbError('CONNECT_FAILED', result.message, { raw: result.raw });
  }
  say(
    `${paint('✓', 'green')} ${result.alreadyConnected ? 'Déjà connecté' : 'Connecté'} à ${formatHostPort(address)}`,
  );
  await touchConnected(address.host, address.host, address.port).catch(() => undefined);
}

async function commandDisconnect(adb: Adb, positionals: string[]): Promise<void> {
  const address = positionals[0] ? requireAddress(positionals[0], "L'adresse est requise") : undefined;
  const result = await adb.disconnect(address);
  ok('disconnect', { output: result.stdout.trim() || result.stderr.trim() });
  say(`${paint('✓', 'green')} ${address ? `Déconnecté de ${formatHostPort(address)}` : 'Tous les appareils Wi-Fi déconnectés'}`);
}

async function commandTcpip(adb: Adb, flags: ParsedArgs['flags']): Promise<void> {
  const port = numberFlag(flags, 'port', 5555);
  const serial = stringFlag(flags, 'serial');

  const devices = await adb.devices();
  const usb = serial
    ? devices.find((d) => d.serial === serial)
    : devices.find((d) => d.transport === 'usb' && d.state === 'device');
  if (!usb) {
    throw new TadbError('NO_DEVICE', 'Aucun appareil branché en USB.', {
      hint: "Branchez le téléphone en USB et autorisez le débogage, puis relancez. Le mode TCP/IP ne s'active pas sans fil.",
    });
  }

  const ip = await adb.deviceIp(usb.serial);
  if (!ip) {
    throw new TadbError('NO_DEVICE', "L'adresse IP Wi-Fi de l'appareil n'a pas pu être déterminée.", {
      hint: 'Vérifiez que le téléphone est bien connecté à un réseau Wi-Fi.',
    });
  }

  await adb.tcpip(port, usb.serial);
  // adbd redémarre en écoute TCP : lui laisser le temps de se relier au port.
  await new Promise((r) => setTimeout(r, 1200));

  const address: HostPort = { host: ip, port };
  const result = await adb.connect(address);
  ok('tcpip', { address, result });
  if (!result.ok) throw new TadbError('CONNECT_FAILED', result.message, { raw: result.raw });
  say(`${paint('✓', 'green')} ${usb.model ?? usb.serial} joignable sur ${formatHostPort(address)}`);
}

async function commandRestart(adb: Adb, flags: ParsedArgs['flags']): Promise<void> {
  await adb.restartServer({
    openscreen: flags.get('openscreen') === true,
    disableAutoConnect: flags.get('no-auto-connect') === true,
  });
  ok('restart', { restarted: true });
  say(`${paint('✓', 'green')} Serveur adb redémarré.`);
}

async function commandHistory(): Promise<void> {
  const devices = await loadHistory();
  ok('history', { devices });
  if (devices.length === 0) {
    say(paint('Aucun appareil associé pour le moment.', 'dim'));
    return;
  }
  say();
  for (const d of devices) {
    say(
      `  ${paint(d.label, 'bold')} ${paint(`— ${d.usbSerial ?? d.id}${d.lastSeenIp ? ` — vu en dernier sur ${d.lastSeenIp}` : ''}`, 'dim')}`,
    );
  }
  // Le port n'est volontairement pas affiché comme réutilisable.
  say();
  say(paint('  Le port change à chaque redémarrage du téléphone : il est redécouvert en mDNS.', 'dim'));
  say();
}

async function commandQr(flags: ParsedArgs['flags']): Promise<void> {
  const credentials = generatePairingCredentials();
  const payload = buildQrPayload(credentials);
  const mode = stringFlag(flags, 'mode');
  ok('qr', { payload, credentials });
  say();
  say(await renderQrTerminal(payload, {
    ...(mode === 'compact' || mode === 'wide' || mode === 'auto' ? { mode } : {}),
  }));
  box('QR d’association (aucun flux lancé)', [
    `Service      : ${paint(credentials.serviceName, 'blue')}`,
    `Mot de passe : ${paint(credentials.password, 'blue')}`,
    '',
    paint('Utilisez `tadb pair-qr` pour lancer l’association complète.', 'dim'),
  ]);
}

/* --------------------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  cli = {
    json: parsed.flags.get('json') === true,
    pretty: parsed.flags.get('pretty') === true,
    color:
      parsed.flags.get('no-color') !== true &&
      parsed.flags.get('json') !== true &&
      !process.env['NO_COLOR'] &&
      process.stdout.isTTY === true,
  };

  const command = parsed.command || (parsed.flags.get('help') ? 'help' : '');

  if (!command || command === 'help' || parsed.flags.get('help') === true) {
    say(HELP);
    return;
  }
  if (command === 'version' || parsed.flags.get('version') === true) {
    const location = await resolveAdbPath(stringFlag(parsed.flags, 'adb'));
    const adbInfo = location ? await new Adb({ adbPath: location.path }).version() : null;
    ok('version', { tadb: SCHEMA_VERSION, adb: adbInfo, adbPath: location?.path ?? null });
    say(`tadb — TIALAO ADB Wireless Connect`);
    say(location ? `adb : ${adbInfo?.version ?? '?'} (${location.path})` : paint('adb introuvable', 'yellow'));
    return;
  }

  const adb = makeAdb(parsed.flags);

  switch (command) {
    case 'devices':
      await commandDevices(adb);
      return;
    case 'mdns':
      await commandMdns(adb, parsed.flags);
      return;
    case 'pair-qr':
      await commandPairQr(adb, parsed.flags);
      return;
    case 'pair':
      await commandPairCode(adb, parsed.positionals, parsed.flags);
      return;
    case 'connect':
      await commandConnect(adb, parsed.positionals);
      return;
    case 'disconnect':
      await commandDisconnect(adb, parsed.positionals);
      return;
    case 'tcpip':
      await commandTcpip(adb, parsed.flags);
      return;
    case 'restart':
      await commandRestart(adb, parsed.flags);
      return;
    case 'history':
      await commandHistory();
      return;
    case 'qr':
      await commandQr(parsed.flags);
      return;
    default:
      throw new TadbError('INVALID_ARGUMENT', `Commande inconnue : ${command}`, {
        hint: 'Lancez `tadb help` pour la liste des commandes.',
      });
  }
}

main().catch((error: unknown) => {
  fail('tadb', toTadbError(error));
});
