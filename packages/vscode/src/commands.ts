import * as vscode from 'vscode';
import {
  dedupeDevices,
  formatHostPort,
  loadHistory,
  pairWithCode,
  touchConnected,
  upsertDevice,
} from 'tialao-adb-wireless';
import type { Adb, AdbDevice, HostPort, PairingResult, StoredDevice } from 'tialao-adb-wireless';
import * as config from './config.ts';
import type { AdbLocator } from './adbLocator.ts';
import type { Logger } from './logger.ts';
import type { StatusBar } from './statusBar.ts';
import { MirrorPanel } from './webview/mirrorPanel.ts';
import { QrPanel, promptForAddress } from './webview/qrPanel.ts';

export interface Context {
  extensionUri: vscode.Uri;
  locator: AdbLocator;
  logger: Logger;
  statusBar: StatusBar;
}

/* --------------------------------------------------------------------------------------- */
/* Utilitaires partagés                                                                      */
/* --------------------------------------------------------------------------------------- */

function deviceLabel(device: AdbDevice): string {
  return device.model ?? device.serial;
}

function transportLabel(device: AdbDevice): string {
  return device.transport === 'usb' ? 'USB' : device.transport === 'tcp' ? 'Wi-Fi' : 'Wi-Fi (mDNS)';
}

/** Enregistre l'appareil dans l'historique partagé avec le CLI. Jamais bloquant. */
async function remember(
  logger: Logger,
  device: AdbDevice | undefined,
  address: HostPort | undefined,
  usbSerial: string | undefined,
): Promise<void> {
  if (!device) return;
  try {
    const id = usbSerial ?? device.usbSerial ?? address?.host ?? device.serial;
    await upsertDevice({
      id,
      label: deviceLabel(device),
      ...(device.model !== undefined ? { model: device.model } : {}),
      ...(usbSerial ?? device.usbSerial ? { usbSerial: usbSerial ?? device.usbSerial } : {}),
      ...(address ? { lastSeenIp: address.host, lastPort: address.port } : {}),
    });
  } catch (error) {
    logger.warn(`L'appareil n'a pas pu être ajouté à l'historique : ${String(error)}`);
  }
}

function announceSuccess(result: PairingResult): void {
  const name = result.device ? deviceLabel(result.device) : 'Appareil';
  vscode.window.showInformationMessage(`${name} est connecté en Wi-Fi.`);
}

/** Affiche une erreur avec son conseil, et un accès direct au journal. */
async function reportError(logger: Logger, message: string, hint?: string): Promise<void> {
  logger.error(message);
  const seeLog = 'Voir le journal';
  const choice = await vscode.window.showErrorMessage(
    hint ? `${message} — ${hint}` : message,
    seeLog,
  );
  if (choice === seeLog) logger.show(false);
}

/* --------------------------------------------------------------------------------------- */
/* Commandes                                                                                 */
/* --------------------------------------------------------------------------------------- */

export async function pairQr(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  QrPanel.show(ctx.extensionUri, adb, ctx.logger, (result) => {
    void remember(ctx.logger, result.device, result.address, result.usbSerial);
    announceSuccess(result);
    void ctx.statusBar.refresh();
  });
}

export async function pairCode(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  const address = await promptForAddress(
    "Adresse « IP:port » affichée sous « Associer l'appareil à l'aide d'un code d'association »",
  );
  if (!address) return;

  const code = await vscode.window.showInputBox({
    title: 'TIALAO ADB — code d’association',
    prompt: 'Code à 6 chiffres affiché sur le téléphone',
    placeHolder: '123456',
    ignoreFocusOut: true,
    validateInput: (input) =>
      /^\d{6}$/.test(input.trim()) ? undefined : 'Le code doit comporter exactement 6 chiffres.',
  });
  if (!code) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'TIALAO ADB', cancellable: true },
    async (progress, token) => {
      const session = pairWithCode(adb, address, code.trim(), {
        timeoutMs: config.discoveryTimeoutMs(),
      });
      token.onCancellationRequested(() => session.cancel());

      session.on((event) => {
        if (event.type === 'state') progress.report({ message: stateMessage(event.to) });
        if (event.type === 'log') ctx.logger.info(event.message);
      });

      const result = await session.done;
      if (result.ok) {
        await remember(ctx.logger, result.device, result.address, result.usbSerial);
        announceSuccess(result);
        await ctx.statusBar.refresh();
      } else if (result.endState !== 'cancelled') {
        await reportError(
          ctx.logger,
          result.error?.message ?? "L'association a échoué.",
          result.error?.hint,
        );
      }
    },
  );
}

function stateMessage(state: string): string {
  switch (state) {
    case 'pairing':
      return 'Association en cours…';
    case 'awaiting-connect':
    case 'connecting':
      return 'Connexion en cours…';
    case 'connected':
      return 'Connecté.';
    default:
      return 'Préparation…';
  }
}

interface DevicePick extends vscode.QuickPickItem {
  address?: HostPort;
  stored?: StoredDevice;
}

export async function connect(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  const items = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Recherche des appareils…' },
    async () => buildConnectPicks(adb),
  );

  const pick = await vscode.window.showQuickPick(items, {
    title: 'TIALAO ADB — connecter un appareil',
    placeHolder: 'Choisissez un appareil découvert, ou saisissez une adresse',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;

  const address = pick.address ?? (await promptForAddress("Adresse « IP:port » de l'appareil"));
  if (!address) return;

  const result = await adb.connect(address);
  if (!result.ok) {
    await reportError(
      ctx.logger,
      `Connexion à ${formatHostPort(address)} impossible : ${result.message}`,
      'Le port change à chaque redémarrage du téléphone. Relancez une découverte plutôt que de réutiliser une ancienne adresse.',
    );
    return;
  }

  await touchConnected(address.host, address.host, address.port).catch(() => undefined);
  vscode.window.showInformationMessage(
    result.alreadyConnected
      ? `Déjà connecté à ${formatHostPort(address)}.`
      : `Connecté à ${formatHostPort(address)}.`,
  );
  await ctx.statusBar.refresh();
}

async function buildConnectPicks(adb: Adb): Promise<DevicePick[]> {
  const items: DevicePick[] = [];

  const [services, history, devices] = await Promise.all([
    adb.mdnsServices().catch(() => []),
    loadHistory().catch(() => [] as StoredDevice[]),
    adb.devices().catch(() => [] as AdbDevice[]),
  ]);

  const connected = new Set(devices.filter((d) => d.state === 'device').map((d) => d.serial));
  const discovered = services.filter((s) => s.type === '_adb-tls-connect._tcp');

  if (discovered.length > 0) {
    items.push({ label: 'Découverts sur le réseau', kind: vscode.QuickPickItemKind.Separator });
    for (const service of discovered) {
      const known = history.find((h) => h.lastSeenIp === service.host);
      const address: HostPort = { host: service.host, port: service.port };
      items.push({
        label: `$(radio-tower) ${known?.label ?? service.instance}`,
        description: formatHostPort(address),
        detail: connected.has(formatHostPort(address)) ? 'Déjà connecté' : undefined,
        address,
      });
    }
  }

  // L'historique sert de repère, mais son port n'est pas réutilisable : ces entrées
  // n'ouvrent pas de connexion directe, elles renvoient vers une saisie ou une découverte.
  const notDiscovered = history.filter((h) => !discovered.some((s) => s.host === h.lastSeenIp));
  if (notDiscovered.length > 0) {
    items.push({ label: 'Déjà associés (non détectés)', kind: vscode.QuickPickItemKind.Separator });
    for (const stored of notDiscovered) {
      items.push({
        label: `$(history) ${stored.label}`,
        description: stored.lastSeenIp ?? '',
        detail:
          'Non détecté en mDNS. Activez le Débogage sans fil sur le téléphone, ou saisissez l’adresse.',
        stored,
      });
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(edit) Saisir une adresse IP:port…',
    detail: "À utiliser quand la découverte mDNS ne trouve rien (pare-feu, isolation Wi-Fi).",
  });

  return items;
}

export async function disconnect(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  // Regroupe les doublons TCP/mDNS d'un meme appareil.
  const devices = dedupeDevices(await adb.devices()).filter((d) => d.transport !== 'usb');
  if (devices.length === 0) {
    vscode.window.showInformationMessage('Aucun appareil connecté en Wi-Fi.');
    return;
  }

  const items: DevicePick[] = devices.map((device) => {
    const item: DevicePick = {
      label: `$(device-mobile) ${deviceLabel(device)}`,
      description: device.serial,
      detail: `${transportLabel(device)} — ${device.state}`,
    };
    if (device.host !== undefined && device.port !== undefined) {
      item.address = { host: device.host, port: device.port };
    }
    return item;
  });
  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(close-all) Tout déconnecter' });

  // Avec un seul appareil, le choix n'apporte rien : on va droit à la confirmation.
  const pick =
    devices.length === 1
      ? items[0]
      : await vscode.window.showQuickPick(items, {
          title: 'TIALAO ADB — déconnecter',
          placeHolder: 'Choisissez un appareil à déconnecter',
        });
  if (!pick) return;

  const target = pick.address ? formatHostPort(pick.address) : 'tous les appareils Wi-Fi';
  const confirm = 'Déconnecter';
  const answer = await vscode.window.showWarningMessage(
    pick.address
      ? `Déconnecter ${pick.description ?? target} ?`
      : 'Déconnecter tous les appareils Wi-Fi ?',
    {
      modal: true,
      detail:
        "L'appareil reste associé : il pourra être reconnecté sans refaire l'association. Les sessions de débogage en cours seront interrompues.",
    },
    confirm,
  );
  if (answer !== confirm) return;

  await adb.disconnect(pick.address);
  vscode.window.showInformationMessage(
    pick.address ? `Déconnecté de ${formatHostPort(pick.address)}.` : 'Tous les appareils Wi-Fi déconnectés.',
  );
  await ctx.statusBar.refresh();
}

export async function tcpip(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  const usb = (await adb.devices()).filter((d) => d.transport === 'usb' && d.state === 'device');
  if (usb.length === 0) {
    await reportError(
      ctx.logger,
      'Aucun appareil branché en USB.',
      "Le mode TCP/IP historique s'active depuis une connexion USB. Branchez le téléphone et autorisez le débogage.",
    );
    return;
  }

  const device =
    usb.length === 1
      ? usb[0]
      : await pickUsbDevice(usb);
  if (!device) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'TIALAO ADB' },
    async (progress) => {
      progress.report({ message: "Recherche de l'adresse IP…" });
      const ip = await adb.deviceIp(device.serial);
      if (!ip) {
        await reportError(
          ctx.logger,
          "L'adresse IP Wi-Fi de l'appareil n'a pas pu être déterminée.",
          'Vérifiez que le téléphone est connecté à un réseau Wi-Fi.',
        );
        return;
      }

      progress.report({ message: 'Bascule en TCP/IP…' });
      await adb.tcpip(5555, device.serial);
      // adbd redémarre en écoute TCP : lui laisser le temps de se relier au port.
      await new Promise((r) => setTimeout(r, 1200));

      const address: HostPort = { host: ip, port: 5555 };
      progress.report({ message: `Connexion à ${formatHostPort(address)}…` });
      const result = await adb.connect(address);
      if (!result.ok) {
        await reportError(ctx.logger, `Connexion à ${formatHostPort(address)} impossible.`, result.message);
        return;
      }

      await remember(ctx.logger, device, address, device.serial);
      vscode.window.showInformationMessage(
        `${deviceLabel(device)} est joignable sur ${formatHostPort(address)}. Vous pouvez débrancher le câble.`,
      );
      await ctx.statusBar.refresh();
    },
  );
}

async function pickUsbDevice(devices: AdbDevice[]): Promise<AdbDevice | undefined> {
  const pick = await vscode.window.showQuickPick(
    devices.map((device) => ({ label: deviceLabel(device), description: device.serial, device })),
    { title: 'TIALAO ADB — choisir l’appareil USB' },
  );
  return pick?.device;
}

export async function restartServer(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Redémarrage du serveur adb…' },
    async () => {
      await adb.restartServer({ disableAutoConnect: config.disableMdnsAutoConnect() });
    },
  );

  vscode.window.showInformationMessage('Serveur adb redémarré.');
  await ctx.statusBar.refresh();
}

export async function showDevices(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  const devices = await adb.devices();
  ctx.logger.info('--- adb devices -l ---');
  if (devices.length === 0) {
    ctx.logger.info('  (aucun appareil)');
  } else {
    for (const device of devices) {
      ctx.logger.info(
        `  ${deviceLabel(device).padEnd(18)} ${transportLabel(device).padEnd(12)} ${device.state.padEnd(14)} ${device.serial}`,
      );
    }
  }
  ctx.logger.show(false);
}

/** Menu ouvert par un clic sur la barre d'état. */
export async function menu(ctx: Context): Promise<void> {
  const connectedCount = dedupeDevices(ctx.statusBar.lastDevices).filter(
    (d) => d.state === 'device',
  ).length;

  const items: Array<vscode.QuickPickItem & { command?: string }> = [
    {
      label: '$(device-mobile) Associer avec un QR code',
      detail: 'Affiche un QR code à scanner depuis le Débogage sans fil',
      command: 'tialaoAdb.pairQr',
    },
    {
      label: '$(key) Associer avec un code à 6 chiffres',
      detail: 'Quand la découverte réseau ne fonctionne pas',
      command: 'tialaoAdb.pairCode',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(plug) Connecter un appareil',
      detail: 'Appareils découverts et historique',
      command: 'tialaoAdb.connect',
    },
    {
      label: '$(debug-disconnect) Déconnecter',
      detail: connectedCount > 0 ? `${String(connectedCount)} appareil(s) connecté(s)` : 'Aucun appareil connecté',
      command: 'tialaoAdb.disconnect',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(screen-full) Afficher l'écran de l'appareil",
      detail: "Miroir interactif dans un onglet de l'éditeur",
      command: 'tialaoAdb.mirror',
    },
    {
      label: '$(list-unordered) Afficher les appareils',
      detail: 'Sortie de adb devices -l dans le journal',
      command: 'tialaoAdb.showDevices',
    },
    {
      label: '$(radio-tower) Mode TCP/IP (Android 10 et antérieurs)',
      detail: 'Depuis un appareil branché en USB',
      command: 'tialaoAdb.tcpip',
    },
    {
      label: '$(debug-restart) Redémarrer le serveur adb',
      detail: 'À essayer quand un appareil reste « offline »',
      command: 'tialaoAdb.restartServer',
    },
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'TIALAO ADB Wireless Connect',
    placeHolder: 'Que voulez-vous faire ?',
  });
  if (pick?.command) await vscode.commands.executeCommand(pick.command);
}

/**
 * Reconnexion au démarrage, si le réglage l'autorise. Le port mémorisé n'est jamais
 * réutilisé : on redécouvre l'appareil en mDNS.
 */
export async function autoConnect(ctx: Context): Promise<void> {
  if (!config.autoConnectOnStartup()) return;

  const history = await loadHistory().catch(() => [] as StoredDevice[]);
  const last = history[0];
  if (!last) return;

  const adb = ctx.locator.create();
  try {
    const services = await adb.mdnsServices();
    const match = services.find(
      (s) => s.type === '_adb-tls-connect._tcp' && (!last.lastSeenIp || s.host === last.lastSeenIp),
    );
    if (!match) {
      ctx.logger.info(`Reconnexion automatique : ${last.label} n'a pas été retrouvé en mDNS.`);
      return;
    }
    const result = await adb.connect({ host: match.host, port: match.port });
    ctx.logger.info(
      result.ok
        ? `Reconnexion automatique à ${last.label} (${match.host}:${String(match.port)}).`
        : `Reconnexion automatique échouée : ${result.message}`,
    );
    if (result.ok) await ctx.statusBar.refresh();
  } catch (error) {
    ctx.logger.warn(`Reconnexion automatique impossible : ${String(error)}`);
  }
}

/** Ouvre le miroir d'écran de l'appareil choisi. */
export async function mirror(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  const devices = dedupeDevices(await adb.devices()).filter((d) => d.state === 'device');
  if (devices.length === 0) {
    await reportError(
      ctx.logger,
      'Aucun appareil disponible.',
      "Associez un appareil, ou vérifiez son état avec « Show connected devices ».",
    );
    return;
  }

  const device =
    devices.length === 1
      ? devices[0]
      : (
          await vscode.window.showQuickPick(
            devices.map((d) => ({
              label: `$(device-mobile) ${deviceLabel(d)}`,
              description: d.serial,
              detail: transportLabel(d),
              device: d,
            })),
            { title: 'TIALAO ADB — quel appareil afficher ?' },
          )
        )?.device;

  if (!device) return;
  await MirrorPanel.show(ctx.extensionUri, adb, device, ctx.logger);
}

/**
 * Ouvre un terminal montrant l'état d'adb et les processus en cours.
 *
 * Le terminal reste ouvert et rendu à l'utilisateur : c'est le moyen le plus direct
 * de poursuivre avec ses propres commandes adb après avoir vu l'état.
 */
export async function openTerminal(ctx: Context): Promise<void> {
  const adb = await ctx.locator.ensure();
  if (!adb) return;

  const adbPath = (await adb.location()).path;
  const terminal = vscode.window.createTerminal({
    name: 'TIALAO ADB',
    iconPath: new vscode.ThemeIcon('device-mobile'),
  });
  terminal.show();

  // Le chemin d'adb n'est PAS interpolé dans la ligne envoyée : un chemin contenant
  // `&`, `;` ou `$(…)` y deviendrait une commande exécutée par le shell. Il est
  // seulement affiché, et l'utilisateur lance ce qu'il veut ensuite.
  ctx.logger.info(`Terminal de diagnostic — adb : ${adbPath}`);
  terminal.sendText(
    process.platform === 'win32'
      ? 'tasklist /FI "IMAGENAME eq adb.exe" /FI "STATUS eq running"'
      : 'ps -eo pid,comm,args | grep -E "adb|scrcpy" | grep -v grep',
  );

}
