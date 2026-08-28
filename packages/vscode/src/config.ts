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

/* --- Miroir d'écran ------------------------------------------------------------------ */

/**
 * Normalise un réglage numérique.
 *
 * `get<number>()` n'est qu'une assertion de type : VS Code n'applique PAS le schéma
 * JSON à l'exécution, et un réglage de workspace peut donc contenir n'importe quoi.
 * Or ces valeurs sont concaténées dans la chaîne passée à `adb shell` : une chaîne
 * hostile y deviendrait une commande exécutée sur le téléphone.
 */
function numberSetting(key: string, fallback: number, min: number, max: number): number {
  const value = Number(config().get(key, fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Plus grande dimension de l'image encodée. Réduire allège l'encodage et le réseau. */
export function mirrorMaxSize(): number {
  return numberSetting('mirrorMaxSize', 1280, 320, 3840);
}

export function mirrorBitRate(): number {
  return numberSetting('mirrorBitRate', 8, 1, 50) * 1_000_000;
}

/** 0 signifie « pas de limite imposée ». */
export function mirrorMaxFps(): number {
  return numberSetting('mirrorMaxFps', 0, 0, 120);
}

/** Chemin d'un scrcpy-server de remplacement. Vide = celui embarqué dans l'extension. */
export function scrcpyServerPath(): string {
  return config().get<string>('scrcpyServerPath', '').trim();
}
