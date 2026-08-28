import { Adb } from '../src/adb.ts';
import type { ExecRunner } from '../src/adb.ts';

export interface FakeReply {
  stdout?: string;
  stderr?: string;
  code?: number;
  timedOut?: boolean;
}

export interface FakeAdbScript {
  /** Répond en fonction des arguments passés à adb. */
  (args: readonly string[], callIndex: number): FakeReply | undefined;
}

export interface FakeAdb {
  adb: Adb;
  /** Toutes les invocations, dans l'ordre : c'est ce qui permet d'affirmer qu'une commande n'a PAS été lancée. */
  calls: string[][];
  callsMatching(prefix: string): string[][];
}

/**
 * Construit un `Adb` réel branché sur un exécuteur factice. On teste ainsi la vraie
 * classe et les vrais parsers, sans binaire adb : seul le lancement du processus est
 * remplacé.
 */
export function makeFakeAdb(script: FakeAdbScript): FakeAdb {
  const calls: string[][] = [];

  const runner: ExecRunner = (_file, args) => {
    const index = calls.length;
    calls.push([...args]);
    const reply = script(args, index) ?? {};
    return Promise.resolve({
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      code: reply.code ?? 0,
      timedOut: reply.timedOut ?? false,
      durationMs: 1,
      command: `adb ${args.join(' ')}`,
    });
  };

  return {
    adb: new Adb({ runner, adbPath: 'adb' }),
    calls,
    callsMatching: (prefix) => calls.filter((c) => c.join(' ').startsWith(prefix)),
  };
}

export const MDNS_OK = 'mdns daemon version [Openscreen discovery 0.0.0]\n';

export function devicesOutput(...lines: string[]): string {
  return ['List of devices attached', ...lines, ''].join('\n');
}

export function mdnsOutput(...lines: string[]): string {
  return ['List of discovered mdns services', ...lines, ''].join('\n');
}

export const USB_LINE =
  'RZGL111VD2M            device product:a17xx model:SM_A175F device:a17 transport_id:1';

export function wirelessLine(host: string, port: number): string {
  return `${host}:${String(port)}       device product:a17xx model:SM_A175F device:a17 transport_id:9`;
}
