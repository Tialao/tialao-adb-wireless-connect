import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { KEYCODE, avcCodecFromConfig, startMirror } from 'tialao-adb-wireless';
import type { Adb, AdbDevice, ScrcpySession, TouchAction } from 'tialao-adb-wireless';
import * as config from '../config.ts';
import type { Logger } from '../logger.ts';

/** Messages du webview vers l'extension. */
type MirrorToHost =
  | { type: 'ready' }
  | { type: 'touch'; action: TouchAction; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; h: number; v: number }
  | { type: 'key'; keycode: number }
  | { type: 'text'; value: string }
  | { type: 'action'; action: string }
  /** Trace émise par le webview : il n'a pas d'autre moyen de se faire entendre. */
  | { type: 'diag'; message: string };

/** Panneau de miroir d'écran. Un seul à la fois par appareil. */
export class MirrorPanel {
  private static readonly open = new Map<string, MirrorPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly logger: Logger;
  private readonly extensionUri: vscode.Uri;
  private readonly serial: string;
  private readonly disposables: vscode.Disposable[] = [];
  private session: ScrcpySession | undefined;
  private disposed = false;

  static async show(
    extensionUri: vscode.Uri,
    adb: Adb,
    device: AdbDevice,
    logger: Logger,
  ): Promise<void> {
    const existing = MirrorPanel.open.get(device.serial);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = new MirrorPanel(extensionUri, device, logger);
    MirrorPanel.open.set(device.serial, panel);
    await panel.start(adb);
  }

  private constructor(extensionUri: vscode.Uri, device: AdbDevice, logger: Logger) {
    this.extensionUri = extensionUri;
    this.serial = device.serial;
    this.logger = logger;

    this.panel = vscode.window.createWebviewPanel(
      'tialaoAdb.mirror',
      `Écran — ${device.model ?? device.serial}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Sans cela, masquer l'onglet détruirait le décodeur et couperait le flux.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'icon.png');
    this.panel.webview.html = this.render();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: MirrorToHost) => {
        this.handleMessage(message);
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private post(message: unknown): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private async start(adb: Adb): Promise<void> {
    this.post({ type: 'status', message: 'Démarrage du miroir…' });

    try {
      const session = await startMirror(adb, {
        serial: this.serial,
        maxSize: config.mirrorMaxSize(),
        bitRate: config.mirrorBitRate(),
        ...(config.mirrorMaxFps() > 0 ? { maxFps: config.mirrorMaxFps() } : {}),
        // Le chemin est TOUJOURS passé explicitement : le cœur le déduirait de
        // `import.meta.url`, qui ne survit pas au bundling CommonJS d'esbuild.
        serverPath:
          config.scrcpyServerPath() ||
          vscode.Uri.joinPath(this.extensionUri, 'vendor', 'scrcpy-server').fsPath,
      });
      this.session = session;

      // La chaîne de codec ne peut être connue qu'après réception du SPS : on garde
      // l'événement `ready` en attente jusque-là, pour ne configurer le décodeur
      // qu'une seule fois, avec la bonne valeur.
      let announced = false;
      let pendingReady: { deviceName: string; width: number; height: number } | undefined;

      session.on((event) => {
        switch (event.type) {
          case 'starting':
            this.post({ type: 'status', message: event.message });
            break;

          case 'ready':
            pendingReady = {
              deviceName: event.deviceName,
              width: event.width,
              height: event.height,
            };
            this.logger.info(
              `Miroir : ${event.deviceName} ${String(event.width)}x${String(event.height)} (${event.codec}).`,
            );
            break;

          case 'frame': {
            if (!announced && event.frame.isConfig && pendingReady) {
              announced = true;
              this.post({
                type: 'ready',
                ...pendingReady,
                codec: avcCodecFromConfig(event.frame.data) ?? 'avc1.42e01e',
              });
            }
            this.post({
              type: 'packet',
              data: Buffer.from(event.frame.data).toString('base64'),
              isConfig: event.frame.isConfig,
              isKeyFrame: event.frame.isKeyFrame,
              ptsUs: event.frame.ptsUs === undefined ? 0 : Number(event.frame.ptsUs),
            });
            break;
          }

          case 'log':
            if (event.level === 'error') this.logger.error(event.message);
            else this.logger.info(`[scrcpy] ${event.message}`);
            break;

          case 'error':
            this.logger.error(`Miroir : ${event.error.message}`);
            this.post({ type: 'status', message: event.error.message });
            break;

          case 'closed':
            this.post({ type: 'closed', reason: event.reason });
            break;
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Le miroir n'a pas pu démarrer : ${message}`, error);
      this.post({ type: 'closed', reason: message });

      const seeLog = 'Voir le journal';
      const choice = await vscode.window.showErrorMessage(
        `Miroir d'écran indisponible : ${message}`,
        seeLog,
      );
      if (choice === seeLog) this.logger.show(false);
    }
  }

  /** Coordonnée plausible dans le repère d'un écran encodé. */
  private static isCoord(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff;
  }

  private handleMessage(message: MirrorToHost): void {
    // Les traces doivent passer même sans session : c'est le cas où elles servent le plus.
    if (message.type === 'diag') {
      this.logger.info(`[miroir] ${message.message}`);
      return;
    }
    const session = this.session;
    if (!session || session.stopped) return;

    switch (message.type) {
      // Ces valeurs finissent dans des `writeUInt32BE` : hors bornes, elles lèveraient
      // une exception non capturée dans le gestionnaire de messages.
      case 'touch':
        if (
          MirrorPanel.isCoord(message.x) &&
          MirrorPanel.isCoord(message.y) &&
          ['down', 'up', 'move'].includes(message.action)
        ) {
          session.touch(message.action, message.x, message.y);
        }
        break;
      case 'scroll':
        if (
          MirrorPanel.isCoord(message.x) &&
          MirrorPanel.isCoord(message.y) &&
          Number.isFinite(message.h) &&
          Number.isFinite(message.v)
        ) {
          session.scroll(message.x, message.y, message.h, message.v);
        }
        break;
      case 'key':
        if (Number.isInteger(message.keycode) && message.keycode >= 0 && message.keycode <= 0xffff) {
          session.tapKey(message.keycode);
        }
        break;
      case 'text':
        // Le clavier envoie caractère par caractère : au-delà, la valeur est aberrante.
        if (typeof message.value === 'string' && message.value.length <= 256) {
          session.text(message.value);
        }
        break;
      case 'action':
        this.runAction(message.action);
        break;
      default:
        break;
    }
  }

  private runAction(action: string): void {
    const session = this.session;
    if (!session) return;

    switch (action) {
      case 'back':
        session.tapKey(KEYCODE.back);
        break;
      case 'home':
        session.tapKey(KEYCODE.home);
        break;
      case 'apps':
        session.tapKey(KEYCODE.appSwitch);
        break;
      case 'power':
        session.tapKey(KEYCODE.power);
        break;
      case 'volumeUp':
        session.tapKey(KEYCODE.volumeUp);
        break;
      case 'volumeDown':
        session.tapKey(KEYCODE.volumeDown);
        break;
      case 'notifications':
        session.expandNotifications();
        break;
      case 'rotate':
        session.rotate();
        break;
      case 'disconnect':
        // Fermer le panneau d'abord : le miroir n'a plus de flux une fois
        // l'appareil deconnecte.
        this.panel.dispose();
        void vscode.commands.executeCommand('tialaoAdb.disconnect');
        break;

      case 'stop':
        this.panel.dispose();
        break;
      default:
        break;
    }
  }

  private uri(name: string): vscode.Uri {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', name),
    );
  }

  private render(): string {
    const nonce = randomBytes(16).toString('base64');
    const { cspSource } = this.panel.webview;
    // `style-src` DOIT accepter le nonce : la taille du cadre est portée par une
    // balise <style> réécrite à chaque redimensionnement. Sans le nonce, la CSP la
    // bloque, `--tadb-view-width` n'est jamais définie, et l'image se peint dans un
    // conteneur de taille nulle — décodée, mais invisible.
    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} data:`,
      `style-src ${cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const button = (action: string, glyph: string, title: string): string =>
      `<button type="button" data-action="${action}" title="${title}"><span class="glyph">${glyph}</span></button>`;

    // Huit poignées : les coins et les bords du cadre, comme une fenêtre classique.
    const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      .map((edge) => `<span class="handle handle-${edge}" data-edge="${edge}"></span>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${this.uri('mirror.css').toString()}" />
<style nonce="${nonce}" id="size-style">:root { --tadb-view-width: 0px; --tadb-view-height: 0px; }</style>
<title>Miroir d'écran</title>
</head>
<body>
  <div class="toolbar">
    ${button('back', '◀', 'Retour')}
    ${button('home', '●', 'Accueil')}
    ${button('apps', '■', 'Applications récentes')}
    <span class="divider"></span>
    ${button('notifications', '▼', 'Panneau de notifications')}
    ${button('rotate', '⟳', "Pivoter l'écran")}
    ${button('volumeDown', '−', 'Volume bas')}
    ${button('volumeUp', '+', 'Volume haut')}
    ${button('power', '⏻', 'Bouton marche/veille')}
    <span class="spacer"></span>
    ${button('zoomOut', '−', 'Réduire')}
    <span class="zoom-label" id="zoom-label">100%</span>
    ${button('zoomIn', '+', 'Agrandir')}
    ${button('fit', '⛶', "Ajuster à la fenêtre")}
    <span class="divider"></span>
    ${button('disconnect', '⏏', "Déconnecter l'appareil")}
  </div>

  <div class="stage" id="stage">
    <p class="placeholder" id="placeholder">Démarrage du miroir…</p>
    <div class="viewport" id="viewport" hidden>
      <canvas id="screen" tabindex="0"></canvas>
      ${handles}
    </div>
  </div>

  <div class="footer">
    <span id="status">Initialisation…</span>
    <span id="stats"></span>
  </div>

<script nonce="${nonce}" src="${this.uri('mirror.js').toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    MirrorPanel.open.delete(this.serial);
    void this.session?.stop('Panneau fermé.');
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
