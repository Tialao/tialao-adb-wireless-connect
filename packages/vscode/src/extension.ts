import * as vscode from 'vscode';
import { AdbLocator } from './adbLocator.ts';
import * as commands from './commands.ts';
import { Logger } from './logger.ts';
import { StatusBar } from './statusBar.ts';

/**
 * Point d'entrée de l'extension.
 *
 * RÈGLE D'ARCHITECTURE : ce package ne contient QUE de l'interface. Toute la logique
 * (adb, mDNS, association, stockage) vit dans `tialao-adb-wireless` et n'est jamais
 * réimplémentée ici — c'est ce qui permet au même cœur de servir le CLI `tadb` et de
 * futurs portages vers d'autres éditeurs.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  const locator = new AdbLocator(logger);
  const statusBar = new StatusBar(locator);

  const ctx: commands.Context = {
    extensionUri: context.extensionUri,
    locator,
    logger,
    statusBar,
  };

  logger.info('TIALAO ADB Wireless Connect activé.');

  const register = (id: string, handler: () => Promise<void> | void): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
        } catch (error) {
          // Filet de sécurité : une commande ne doit jamais remonter une exception
          // brute à l'utilisateur sans que le journal en garde la trace.
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Commande ${id} en échec : ${message}`, error);
          const seeLog = 'Voir le journal';
          const choice = await vscode.window.showErrorMessage(`TIALAO ADB : ${message}`, seeLog);
          if (choice === seeLog) logger.show(false);
        }
      }),
    );
  };

  register('tialaoAdb.pairQr', () => commands.pairQr(ctx));
  register('tialaoAdb.pairCode', () => commands.pairCode(ctx));
  register('tialaoAdb.connect', () => commands.connect(ctx));
  register('tialaoAdb.disconnect', () => commands.disconnect(ctx));
  register('tialaoAdb.tcpip', () => commands.tcpip(ctx));
  register('tialaoAdb.restartServer', () => commands.restartServer(ctx));
  register('tialaoAdb.showDevices', () => commands.showDevices(ctx));
  register('tialaoAdb.mirror', () => commands.mirror(ctx));
  register('tialaoAdb.openTerminal', () => commands.openTerminal(ctx));
  register('tialaoAdb.menu', () => commands.menu(ctx));

  context.subscriptions.push(logger, statusBar);

  void commands.autoConnect(ctx);
}

export function deactivate(): void {
  // Tout est enregistré dans context.subscriptions : VS Code libère les ressources.
}
