import * as vscode from 'vscode';
import { dedupeDevices } from 'tialao-adb-wireless';
import type { AdbDevice } from 'tialao-adb-wireless';
import * as config from './config.ts';
import type { AdbLocator } from './adbLocator.ts';

const REFRESH_INTERVAL_MS = 5_000;

/**
 * Élément de barre d'état : l'appareil connecté, cliquable pour ouvrir le menu.
 *
 * Le rafraîchissement se met en pause quand la fenêtre n'a pas le focus — inutile de
 * lancer un `adb devices` toutes les 5 secondes derrière une fenêtre invisible.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly locator: AdbLocator;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private devices: AdbDevice[] = [];
  private refreshing = false;

  constructor(locator: AdbLocator) {
    this.locator = locator;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'tialaoAdb.menu';
    this.disposables.push(this.item);

    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refresh();
      }),
      config.onDidChange(() => this.applyVisibility()),
    );

    this.applyVisibility();
  }

  /** Dernier état connu, réutilisé par les QuickPick pour éviter un appel adb de plus. */
  get lastDevices(): readonly AdbDevice[] {
    return this.devices;
  }

  private applyVisibility(): void {
    if (config.showStatusBar()) {
      this.item.show();
      this.start();
    } else {
      this.item.hide();
      this.stop();
    }
  }

  private start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      if (vscode.window.state.focused) void this.refresh();
    }, REFRESH_INTERVAL_MS);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    // Un `adb devices` peut dépasser 5 s au démarrage du daemon : ne pas empiler.
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const adb = this.locator.create();
      this.devices = await adb.devices();
      this.render();
    } catch {
      this.devices = [];
      this.item.text = '$(device-mobile) adb ?';
      this.item.tooltip = "adb est introuvable. Cliquez pour ouvrir le menu TIALAO ADB.";
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } finally {
      this.refreshing = false;
    }
  }

  private render(): void {
    // adb liste le meme telephone deux fois apres une connexion sans fil (entree TCP
    // + entree mDNS) : sans regroupement, la barre d'etat afficherait « +1 ».
    const usable = dedupeDevices(this.devices).filter((d) => d.state === 'device');
    const wireless = usable.filter((d) => d.transport !== 'usb');
    const shown = wireless[0] ?? usable[0];

    if (!shown) {
      this.item.text = '$(device-mobile) No device';
      this.item.tooltip = new vscode.MarkdownString(
        'Aucun appareil connecté.\n\nCliquez pour associer un appareil.',
      );
      this.item.backgroundColor = undefined;
      return;
    }

    const name = shown.model ?? shown.serial;
    const extra = usable.length > 1 ? ` +${String(usable.length - 1)}` : '';
    this.item.text = `$(device-mobile) ${name}${extra}`;

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown('**TIALAO ADB Wireless Connect**\n\n');
    for (const device of dedupeDevices(this.devices)) {
      const where =
        device.transport === 'usb' ? 'USB' : device.transport === 'tcp' ? 'Wi-Fi' : 'Wi-Fi (mDNS)';
      const icon = device.state === 'device' ? '$(pass-filled)' : '$(warning)';
      tooltip.appendMarkdown(`${icon} \`${device.serial}\` — ${where} — ${device.state}\n\n`);
    }
    tooltip.appendMarkdown('_Cliquez pour ouvrir le menu._');
    tooltip.supportThemeIcons = true;
    this.item.tooltip = tooltip;

    // Un appareil `offline` est la panne la plus fréquente : la signaler visuellement.
    this.item.backgroundColor = this.devices.some((d) => d.state === 'offline')
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose(): void {
    this.stop();
    for (const d of this.disposables) d.dispose();
  }
}
