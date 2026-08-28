import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawExec } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Charge une fixture SANS normaliser les fins de ligne : les variantes `.crlf.txt`
 * ne testent quelque chose que si leurs `\r` arrivent intacts jusqu'au parser.
 */
export function fixture(name: string): string {
  return readFileSync(join(HERE, 'fixtures', name), 'utf8');
}

/** Construit un RawExec factice pour tester les parsers de verdict. */
export function makeExec(partial: Partial<RawExec> = {}): RawExec {
  return {
    stdout: '',
    stderr: '',
    code: 0,
    timedOut: false,
    durationMs: 12,
    command: 'adb (test)',
    ...partial,
  };
}
