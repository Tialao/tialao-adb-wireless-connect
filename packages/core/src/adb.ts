/**
 * Wrapper adb : UNIQUE endroit du projet où un processus est lancé.
 *
 * Règles tenues ici, et nulle part ailleurs :
 *  - `execFile` avec un tableau d'arguments, jamais `exec` ni `shell: true`. C'est ce qui
 *    rend les chemins avec espaces et les valeurs saisies par l'utilisateur inoffensifs.
 *  - timeout et `maxBuffer` explicites sur chaque appel.
 *  - toute invocation est journalisée via `onLog`, avec sa sortie brute : c'est le seul
 *    moyen de diagnostiquer un problème adb à distance.
 *  - le parsing est délégué à `parse.ts` (fonctions pures, testées sans adb).
 */

import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { TadbError } from './errors.ts';
import {
  formatHostPort,
  parseAdbVersion,
  parseConnectOutput,
  parseDevices,
  parseDeviceIp,
  parseMdnsCheck,
  parseMdnsServices,
  parsePairOutput,
} from './parse.ts';
import type {
  AdbDevice,
  AdbVersion,
  ConnectResult,
  HostPort,
  MdnsCheck,
  MdnsService,
  PairResult,
  RawExec,
} from './types.ts';

const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export interface AdbLogEntry {
  command: string;
  args: readonly string[];
  durationMs: number;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Signature d'exécution, injectable : c'est ce qui permet de tester sans adb installé. */
export type ExecRunner = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<RawExec>;

export interface AdbOptions {
  /** Chemin explicite vers adb. Sinon, résolution automatique. */
  adbPath?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onLog?: (entry: AdbLogEntry) => void;
  runner?: ExecRunner;
}

/* --------------------------------------------------------------------------------------- */
/* Résolution du binaire adb                                                                 */
/* --------------------------------------------------------------------------------------- */

export interface AdbLocation {
  path: string;
  source: 'explicit' | 'env' | 'path' | 'sdk';
}

const ADB_BIN = IS_WINDOWS ? 'adb.exe' : 'adb';

/** Emplacements standards d'installation du SDK Android, par plateforme. */
function sdkCandidates(): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const push = (dir: string | undefined): void => {
    if (dir) dirs.push(join(dir, 'platform-tools'));
  };

  push(process.env['ANDROID_HOME']);
  push(process.env['ANDROID_SDK_ROOT']);
  if (IS_WINDOWS) {
    push(process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Android', 'Sdk') : undefined);
  }
  if (process.platform === 'darwin') {
    dirs.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools'));
  }
  dirs.push(join(home, 'Android', 'Sdk', 'platform-tools'));

  return dirs.map((d) => join(d, ADB_BIN));
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    // X_OK n'a pas de sens sur Windows : on se contente de l'existence.
    await access(candidate, IS_WINDOWS ? constants.F_OK : constants.F_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Cherche `adb` dans le PATH, en respectant PATHEXT sous Windows. */
async function findOnPath(name: string): Promise<string | null> {
  const paths = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const extensions = IS_WINDOWS
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const dir of paths) {
    for (const ext of extensions) {
      const candidate = join(dir, name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Résout le chemin d'adb : chemin explicite, puis TIALAO_ADB_PATH, puis PATH,
 * puis les emplacements standards du SDK Android.
 */
export async function resolveAdbPath(explicit?: string): Promise<AdbLocation | null> {
  const candidate = explicit?.trim();
  if (candidate && candidate !== 'adb' && candidate !== 'adb.exe') {
    if (isAbsolute(candidate)) {
      return (await isExecutable(candidate)) ? { path: candidate, source: 'explicit' } : null;
    }
    const found = await findOnPath(candidate);
    return found ? { path: found, source: 'explicit' } : null;
  }

  const fromEnv = process.env['TIALAO_ADB_PATH']?.trim();
  if (fromEnv && (await isExecutable(fromEnv))) {
    return { path: fromEnv, source: 'env' };
  }

  const onPath = await findOnPath(ADB_BIN);
  if (onPath) return { path: onPath, source: 'path' };

  for (const sdk of sdkCandidates()) {
    if (await isExecutable(sdk)) return { path: sdk, source: 'sdk' };
  }

  return null;
}

/* --------------------------------------------------------------------------------------- */
/* Exécution                                                                                 */
/* --------------------------------------------------------------------------------------- */

/**
 * Un shim `.cmd`/`.bat` (scoop, chocolatey) ne peut pas être lancé directement par
 * `execFile` sous Windows : il faut passer par ComSpec. On ne bascule JAMAIS sur
 * `shell: true`, qui rouvrirait la porte à l'injection d'arguments.
 *
 * Chaque argument est mis entre guillemets SANS CONDITION. Une version antérieure ne
 * le faisait que pour les arguments contenant un espace ou un guillemet — ce qui
 * laissait passer `&`, `|`, `<`, `>`, `^`, `(` et `)`, tous interprétés par `cmd.exe` :
 * un hôte `1.2.3.4&calc.exe` faisait exécuter `calc.exe`.
 */
function quoteForCmd(argument: string): string {
  // `cmd.exe` échappe le guillemet interne par doublement, pas par antislash.
  return `"${argument.replace(/"/g, '""')}"`;
}

/**
 * `%VAR%` est développé par `cmd.exe` MÊME entre guillemets : aucun échappement ne
 * l'en empêche. Un argument qui en contient ne peut donc pas être transmis sûrement
 * par un shim, et l'on refuse plutôt que de transmettre une valeur altérée.
 */
function rejectsPercentExpansion(args: readonly string[]): string | undefined {
  return args.find((a) => a.includes('%'));
}

export function adaptForWindowsShim(
  file: string,
  args: readonly string[],
): [string, string[]] {
  if (!IS_WINDOWS || !/\.(cmd|bat)$/i.test(file)) return [file, [...args]];

  const dangerous = rejectsPercentExpansion([file, ...args]);
  if (dangerous !== undefined) {
    throw new TadbError(
      'INVALID_ARGUMENT',
      `Argument refusé : « ${dangerous} » contient « % », que cmd.exe développerait.`,
      {
        hint: "Renseignez le chemin du binaire adb.exe lui-même plutôt qu'un script .cmd (réglage tialaoAdb.adbPath).",
      },
    );
  }

  const comspec = process.env['ComSpec'] ?? 'cmd.exe';
  const line = [file, ...args].map(quoteForCmd).join(' ');
  return [comspec, ['/d', '/s', '/c', line]];
}

export const defaultRunner: ExecRunner = (file, args, options) =>
  new Promise<RawExec>((resolve, reject) => {
    const startedAt = Date.now();
    const [bin, finalArgs] = adaptForWindowsShim(file, args);
    // Meme masquage que pour le journal : ce champ voyage dans RawExec et peut
    // etre affiche par un appelant.
    const command = `${file} ${redactSecrets(args).join(' ')}`;

    const execOptions: Parameters<typeof execFile>[2] = {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: DEFAULT_MAX_BUFFER,
      encoding: 'utf8',
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    execFile(bin, finalArgs, execOptions, (error, stdout, stderr) => {
      const durationMs = Date.now() - startedAt;
      const out = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      const err = typeof stderr === 'string' ? stderr : stderr.toString('utf8');

      if (error) {
        const sys = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };

        // Échec de spawn : adb n'existe pas ou n'est pas exécutable. C'est distinct
        // d'un adb qui répond en signalant une erreur métier.
        if (sys.code === 'ENOENT' || sys.code === 'EACCES' || sys.code === 'EINVAL') {
          reject(
            new TadbError('ADB_NOT_FOUND', `Impossible de lancer « ${file} » (${sys.code}).`, {
              cause: error,
            }),
          );
          return;
        }

        if (sys.name === 'AbortError' || sys.code === 'ABORT_ERR') {
          reject(new TadbError('CANCELLED', 'Commande adb annulée.', { cause: error }));
          return;
        }

        const timedOut = sys.killed === true && sys.signal !== null && sys.signal !== undefined;
        resolve({
          stdout: out,
          stderr: err,
          code: typeof sys.code === 'number' ? sys.code : null,
          timedOut,
          durationMs,
          command,
        });
        return;
      }

      resolve({ stdout: out, stderr: err, code: 0, timedOut: false, durationMs, command });
    });
  });

/* --------------------------------------------------------------------------------------- */
/* Façade adb                                                                                */
/* --------------------------------------------------------------------------------------- */

/**
 * Masque les secrets avant journalisation.
 *
 * `adb pair <adresse> <code>` porte le mot de passe d'association en clair sur sa
 * ligne de commande. Le journal est destiné à être lu, copié et collé dans un rapport
 * de bug : ce secret n'a rien à y faire, même s'il est éphémère.
 */
export function redactSecrets(args: readonly string[]): string[] {
  const out = [...args];
  // Le verbe est en tête, ou juste après un sélecteur `-s <serial>`. On ancre sur ces
  // deux positions plutôt que sur un `indexOf`, qui masquerait au mauvais endroit si
  // un argument valait littéralement « pair ».
  const verbIndex = out[0] === 'pair' ? 0 : out[0] === '-s' && out[2] === 'pair' ? 2 : -1;
  // Le mot de passe est le second argument positionnel de `pair`.
  if (verbIndex !== -1 && out.length > verbIndex + 2) {
    out[verbIndex + 2] = '••••••••';
  }
  return out;
}

export class Adb {
  private readonly options: AdbOptions;
  private readonly runner: ExecRunner;
  private resolved: AdbLocation | null = null;

  constructor(options: AdbOptions = {}) {
    this.options = options;
    this.runner = options.runner ?? defaultRunner;
  }

  /** Chemin d'adb effectivement utilisé, résolu une seule fois puis mémorisé. */
  async location(): Promise<AdbLocation> {
    if (this.resolved) return this.resolved;
    // Avec un runner injecté (tests, ou hôte qui fournit son propre exécuteur), on ne
    // sonde pas le disque : le binaire peut très bien ne pas exister.
    if (this.options.runner) {
      this.resolved = { path: this.options.adbPath ?? 'adb', source: 'explicit' };
      return this.resolved;
    }
    const found = await resolveAdbPath(this.options.adbPath);
    if (!found) {
      throw new TadbError('ADB_NOT_FOUND', "Le binaire adb est introuvable sur ce système.");
    }
    this.resolved = found;
    return found;
  }

  /** Lance adb avec des arguments bruts. Toute autre méthode passe par ici. */
  async raw(args: readonly string[], options: ExecOptions = {}): Promise<RawExec> {
    const { path } = await this.location();
    const execOptions: ExecOptions = {
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(options.env ?? this.options.env ? { env: options.env ?? this.options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const result = await this.runner(path, args, execOptions);

    this.options.onLog?.({
      command: `adb ${redactSecrets(args).join(' ')}`,
      // Masqué ici aussi : `AdbLogEntry` fait partie de la surface publique, et un
      // hôte tiers qui journaliserait `args` rouvrirait la fuite.
      args: redactSecrets(args),
      durationMs: result.durationMs,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });

    return result;
  }

  /**
   * Lance adb en processus long, dont on veut lire la sortie au fil de l'eau.
   *
   * Passe par le même adaptateur de shim Windows que `raw()` : sans lui, un adb
   * installé en `.cmd` ne peut pas être lancé du tout depuis Node 20.12.
   */
  async spawn(args: readonly string[]): Promise<ChildProcess> {
    const { path } = await this.location();
    const [bin, finalArgs] = adaptForWindowsShim(path, args);
    this.options.onLog?.({
      command: `adb ${redactSecrets(args).join(' ')}`,
      args: redactSecrets(args),
      durationMs: 0,
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    });
    return spawn(bin, finalArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(this.options.env ? { env: this.options.env } : {}),
    });
  }

  async version(): Promise<AdbVersion> {
    const r = await this.raw(['--version'], { timeoutMs: 5_000 });
    return parseAdbVersion(r.stdout || r.stderr);
  }

  async devices(): Promise<AdbDevice[]> {
    const r = await this.raw(['devices', '-l']);
    return parseDevices(r.stdout);
  }

  async mdnsCheck(): Promise<MdnsCheck> {
    const r = await this.raw(['mdns', 'check'], { timeoutMs: 10_000 });
    return parseMdnsCheck(r.stdout, r.stderr, r.code);
  }

  async mdnsServices(): Promise<MdnsService[]> {
    const r = await this.raw(['mdns', 'services'], { timeoutMs: 10_000 });
    return parseMdnsServices(r.stdout);
  }

  /** `adb pair <host:port> <code>` — le verdict vient du texte, pas du code de sortie. */
  async pair(address: HostPort, code: string, options: ExecOptions = {}): Promise<PairResult> {
    const r = await this.raw(['pair', formatHostPort(address), code], {
      timeoutMs: 30_000,
      ...options,
    });
    return parsePairOutput(r);
  }

  async connect(address: HostPort, options: ExecOptions = {}): Promise<ConnectResult> {
    const r = await this.raw(['connect', formatHostPort(address)], {
      timeoutMs: 20_000,
      ...options,
    });
    return parseConnectOutput(r);
  }

  async disconnect(address?: HostPort): Promise<RawExec> {
    return this.raw(address ? ['disconnect', formatHostPort(address)] : ['disconnect']);
  }

  /** Bascule adbd en TCP/IP (Android <= 10, ou appareil branché en USB). */
  async tcpip(port: number, serial?: string): Promise<RawExec> {
    const args = serial ? ['-s', serial, 'tcpip', String(port)] : ['tcpip', String(port)];
    return this.raw(args, { timeoutMs: 20_000 });
  }

  async killServer(): Promise<RawExec> {
    return this.raw(['kill-server'], { timeoutMs: 10_000 });
  }

  async startServer(extraEnv?: NodeJS.ProcessEnv): Promise<RawExec> {
    return this.raw(['start-server'], {
      timeoutMs: 20_000,
      env: { ...process.env, ...this.options.env, ...extraEnv },
    });
  }

  /**
   * Redémarre le serveur adb. `openscreen` force le backend mDNS Openscreen ;
   * `disableAutoConnect` empêche adb de se connecter tout seul aux services découverts.
   */
  async restartServer(options: { openscreen?: boolean; disableAutoConnect?: boolean } = {}): Promise<void> {
    await this.killServer();
    // Le port 5037 reste brièvement lié après kill-server : redémarrer trop vite échoue.
    await sleep(400);

    const env: NodeJS.ProcessEnv = {};
    if (options.openscreen) env['ADB_MDNS_OPENSCREEN'] = '1';
    if (options.disableAutoConnect) env['ADB_MDNS_AUTO_CONNECT'] = '';

    const first = await this.startServer(env);
    if (first.code === 0) return;

    await sleep(600);
    await this.startServer(env);
  }

  /** IP Wi-Fi de l'appareil, pour le mode TCP/IP historique. */
  async deviceIp(serial?: string): Promise<string | null> {
    const prefix = serial ? ['-s', serial] : [];
    const route = await this.raw([...prefix, 'shell', 'ip', 'route'], { timeoutMs: 10_000 });
    const fromRoute = parseDeviceIp(route.stdout);
    if (fromRoute) return fromRoute;

    const addr = await this.raw([...prefix, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], {
      timeoutMs: 10_000,
    });
    return parseDeviceIp(route.stdout, addr.stdout);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
