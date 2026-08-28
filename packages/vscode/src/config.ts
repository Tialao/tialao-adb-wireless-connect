import * as vscode from 'vscode';

/** Accès typé aux réglages `tialaoAdb.*`. Un seul endroit connaît leurs noms. */

const SECTION = 'tialaoAdb';

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

export function adbPath(): string {
  return config().get<string>('adbPath', 'adb');
}

export function autoConnectOnStartup(): boolean {
  return config().get<boolean>('autoConnectOnStartup', false);
}

/** Timeout de découverte, exprimé en millisecondes pour le cœur. */
export function discoveryTimeoutMs(): number {
  const seconds = config().get<number>('discoveryTimeout', 120);
  return Math.max(10, seconds) * 1000;
}

export function showStatusBar(): boolean {
  return config().get<boolean>('showStatusBar', true);
}

export function disableMdnsAutoConnect(): boolean {
  return config().get<boolean>('disableMdnsAutoConnect', false);
}

export async function setAdbPath(value: string): Promise<void> {
  await config().update('adbPath', value, vscode.ConfigurationTarget.Global);
}

export function onDidChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener();
  });
}
