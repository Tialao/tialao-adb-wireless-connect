import * as vscode from 'vscode';
import type { AdbLogEntry } from 'tialao-adb-wireless';

/**
 * Journal « TIALAO ADB ». Il consigne CHAQUE commande adb et sa sortie brute.
 *
 * Ce n'est pas du confort : quand le mDNS ne découvre rien ou qu'un appareil reste
 * `offline`, la sortie brute d'adb est la seule information exploitable, et c'est ce
 * qu'on demandera à l'utilisateur de coller dans un rapport de bug.
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('TIALAO ADB');
  }

  private stamp(): string {
    return new Date().toLocaleTimeString();
  }

  info(message: string): void {
    this.channel.appendLine(`[${this.stamp()}] ${message}`);
  }

  warn(message: string): void {
    this.channel.appendLine(`[${this.stamp()}] ! ${message}`);
  }

  error(message: string, error?: unknown): void {
    this.channel.appendLine(`[${this.stamp()}] ✖ ${message}`);
    if (error instanceof Error && error.stack) this.channel.appendLine(error.stack);
  }

  /** Trace une invocation d'adb : la commande, sa durée, puis sa sortie brute indentée. */
  command(entry: AdbLogEntry): void {
    const status = entry.timedOut ? 'TIMEOUT' : `code=${String(entry.code)}`;
    this.channel.appendLine(
      `[${this.stamp()}] $ ${entry.command}  (${String(entry.durationMs)} ms, ${status})`,
    );
    for (const stream of [entry.stdout, entry.stderr]) {
      const text = stream.trim();
      if (!text) continue;
      for (const line of text.split(/\r?\n/)) this.channel.appendLine(`    ${line}`);
    }
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
