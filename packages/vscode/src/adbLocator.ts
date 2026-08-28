import * as vscode from 'vscode';
import { Adb, resolveAdbPath } from 'tialao-adb-wireless';
import type { AdbLocation } from 'tialao-adb-wireless';
import * as config from './config.ts';
import type { Logger } from './logger.ts';

/**
 * Fabrique les instances d'`Adb` et gère le cas « adb introuvable ».
 *
 * Toute la recherche vit dans le cœur (`resolveAdbPath`) ; ici on n'ajoute que
 * l'interaction : prévenir l'utilisateur et lui proposer d'enregistrer le chemin trouvé.
 */
export class AdbLocator {
  private readonly logger: Logger;
  private warned = false;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Instance d'adb configurée, journalisation branchée. */
  create(): Adb {
    return new Adb({
      adbPath: config.adbPath(),
      onLog: (entry) => this.logger.command(entry),
    });
  }

  /**
   * Vérifie qu'adb est joignable. Si le réglage pointe dans le vide mais qu'un adb
   * existe ailleurs, on propose de corriger le réglage plutôt que d'échouer.
   */
  async ensure(): Promise<Adb | undefined> {
    const configured = config.adbPath();
    const location = await resolveAdbPath(configured);
    if (location) {
      this.logger.info(`adb : ${location.path} (source : ${location.source})`);
      return this.create();
    }

    const fallback = await resolveAdbPath();
    await this.reportMissing(configured, fallback);
    return undefined;
  }

  private async reportMissing(configured: string, fallback: AdbLocation | null): Promise<void> {
    this.logger.warn(`adb introuvable (réglage tialaoAdb.adbPath = « ${configured} »).`);

    if (fallback) {
      const useIt = 'Utiliser ce chemin';
      const choice = await vscode.window.showWarningMessage(
        `adb est introuvable à « ${configured} », mais a été trouvé dans ${fallback.path}.`,
        useIt,
        'Ouvrir les réglages',
      );
      if (choice === useIt) {
        await config.setAdbPath(fallback.path);
        vscode.window.showInformationMessage(`tialaoAdb.adbPath réglé sur ${fallback.path}.`);
      } else if (choice === 'Ouvrir les réglages') {
        await openSettings();
      }
      return;
    }

    if (this.warned) return;
    this.warned = true;

    const choice = await vscode.window.showErrorMessage(
      "adb est introuvable. Installez les platform-tools Android, puis indiquez le chemin du binaire.",
      'Ouvrir les réglages',
      'Télécharger les platform-tools',
    );
    if (choice === 'Ouvrir les réglages') {
      await openSettings();
    } else if (choice === 'Télécharger les platform-tools') {
      await vscode.env.openExternal(
        vscode.Uri.parse('https://developer.android.com/tools/releases/platform-tools'),
      );
    }
  }
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'tialaoAdb.adbPath');
}
