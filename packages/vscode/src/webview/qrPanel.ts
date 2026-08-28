import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Adb, HostPort, PairingEvent, PairingResult, PairingState } from 'tialao-adb-wireless';
import { formatHostPort, parseHostPort, startQrPairing } from 'tialao-adb-wireless';
import type { HostToWebview, StepId, WebviewToHost } from './protocol.ts';
import * as config from '../config.ts';
import type { Logger } from '../logger.ts';

const STEP_LABELS: Record<StepId, string> = {
  scan: 'Scan du QR code',
  pairing: 'Association',
  connecting: 'Connexion',
  connected: 'Connecté',
};

/** Traduit l'état interne du cœur en une étape affichable et un libellé lisible. */
function describeState(state: PairingState): { step: StepId; label: string } {
  switch (state) {
    case 'checking-mdns':
      return { step: 'scan', label: 'Vérification de la découverte réseau…' };
    case 'awaiting-scan':
      return { step: 'scan', label: 'En attente du scan du QR code…' };
    case 'pairing':
      return { step: 'pairing', label: 'Association en cours…' };
    case 'awaiting-connect':
    case 'connecting':
      return { step: 'connecting', label: 'Connexion en cours…' };
    case 'connected':
      return { step: 'connected', label: 'Appareil connecté' };
    case 'timeout':
      return { step: 'scan', label: 'Délai dépassé' };
    case 'cancelled':
      return { step: 'scan', label: 'Annulé' };
    default:
      return { step: 'scan', label: 'Préparation…' };
  }
}

export class QrPanel {
  private static current: QrPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly logger: Logger;
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onSuccess: (result: PairingResult) => void;
  private adb: Adb;
  private session: ReturnType<typeof startQrPairing> | undefined;
  private unsubscribe: (() => void) | undefined;

  static show(
    extensionUri: vscode.Uri,
    adb: Adb,
    logger: Logger,
    onSuccess: (result: PairingResult) => void,
  ): QrPanel {
    // Un seul panneau : deux associations simultanées se disputeraient le serveur adb.
    if (QrPanel.current) {
      QrPanel.current.panel.reveal(vscode.ViewColumn.Active);
      QrPanel.current.restart(adb);
      return QrPanel.current;
    }
    QrPanel.current = new QrPanel(extensionUri, adb, logger, onSuccess);
    return QrPanel.current;
  }

  private constructor(
    extensionUri: vscode.Uri,
    adb: Adb,
    logger: Logger,
    onSuccess: (result: PairingResult) => void,
  ) {
    this.extensionUri = extensionUri;
    this.adb = adb;
    this.logger = logger;
    this.onSuccess = onSuccess;

    this.panel = vscode.window.createWebviewPanel(
      'tialaoAdb.qrPanel',
      'TIALAO ADB — Associer un appareil',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );

    this.panel.webview.html = this.render();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewToHost) => {
        void this.handleMessage(message);
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );

    this.start();
  }

  private post(message: HostToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private restart(adb: Adb): void {
    this.adb = adb;
    this.session?.cancel('Nouvelle association demandée.');
    this.panel.webview.html = this.render();
    this.start();
  }

  private start(): void {
    const timeoutMs = config.discoveryTimeoutMs();
    this.logger.info(`Association par QR code — timeout de découverte : ${String(timeoutMs / 1000)} s.`);

    const session = startQrPairing(this.adb, { timeoutMs });
    this.session = session;

    this.unsubscribe = session.on((event) => this.handleEvent(event, timeoutMs));

    void session.done.then((result) => {
      if (result.ok) this.onSuccess(result);
    });
  }

  private handleEvent(event: PairingEvent, timeoutMs: number): void {
    switch (event.type) {
      case 'qr-ready':
        this.post({
          type: 'qr',
          svg: event.svg ?? '',
          payload: event.payload,
          credentials: event.credentials,
          timeoutMs,
        });
        break;

      case 'state': {
        const { step, label } = describeState(event.to);
        this.post({ type: 'state', state: event.to, step, label });
        break;
      }

      case 'poll':
        this.post({ type: 'countdown', remainingMs: event.remainingMs, totalMs: timeoutMs });
        break;

      case 'connected': {
        const name = event.device.model ?? event.device.serial;
        const detail = event.viaAutoConnect
          ? "adb s'est connecté automatiquement dès la découverte de l'appareil."
          : `Connecté à ${event.address ? formatHostPort(event.address) : event.device.serial}.`;
        this.post({ type: 'connected', label: `${name} est connecté`, detail });
        break;
      }

      case 'error':
        if (event.fatal) {
          this.post({
            type: 'failed',
            message: event.message,
            ...(event.hint !== undefined ? { hint: event.hint } : {}),
            canRetry: true,
          });
        } else {
          // Non fatal : typiquement « le mDNS ne voit rien ». On informe sans casser
          // le flux, l'utilisateur peut encore scanner ou saisir l'adresse à la main.
          this.post({
            type: 'notice',
            level: 'warn',
            message: event.message,
            ...(event.hint !== undefined ? { hint: event.hint } : {}),
          });
        }
        this.logger.warn(`${event.code} : ${event.message}`);
        break;

      case 'log':
        if (event.level === 'warn' || event.level === 'error') this.logger.warn(event.message);
        else this.logger.info(event.message);
        break;

      default:
        break;
    }
  }

  private async handleMessage(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case 'cancel':
        this.session?.cancel();
        this.panel.dispose();
        break;

      case 'retry':
        this.restart(this.adb);
        break;

      case 'manual': {
        const address = await promptForAddress();
        if (address) this.session?.submitManualAddress(address);
        break;
      }

      case 'copy':
        await vscode.env.clipboard.writeText(message.value);
        vscode.window.setStatusBarMessage(`${message.what} copié dans le presse-papiers.`, 2000);
        break;

      default:
        break;
    }
  }

  private uri(...segments: string[]): vscode.Uri {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', ...segments),
    );
  }

  private render(): string {
    const nonce = randomBytes(16).toString('base64');
    const { cspSource } = this.panel.webview;

    // CSP stricte : aucune source externe, le script uniquement par nonce. Les styles
    // proviennent des ressources locales, plus une balise <style> noncée pour la seule
    // valeur dynamique (la progression) — jamais de style inline sur un élément.
    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} data:`,
      `style-src ${cspSource} 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${cspSource}`,
    ].join('; ');

    const steps = (['scan', 'pairing', 'connecting', 'connected'] as StepId[])
      .map(
        (id) =>
          `<li class="step" data-step="${id}"><span class="bar"></span><span class="label">${STEP_LABELS[id]}</span></li>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${this.uri('qr.css').toString()}" />
<style nonce="${nonce}" id="progress-style">:root { --tadb-progress: 0.06; }</style>
<title>Associer un appareil</title>
</head>
<body>
<main class="shell">
  <header class="header">
    <h1>Associer un appareil Android</h1>
    <p>
      Sur le téléphone : <strong>Paramètres → Options pour les développeurs → Débogage sans fil</strong>,
      puis <strong>Associer l'appareil à l'aide d'un QR code</strong>. Les deux appareils doivent être
      sur le même réseau Wi-Fi.
    </p>
  </header>

  <section class="qr-card">
    <div class="qr-frame" id="qr-frame" role="img" aria-label="QR code d'association"></div>
    <p class="qr-hint">Scannez ce code avec l'appareil photo de l'écran <strong>Débogage sans fil</strong>.</p>

    <dl class="creds">
      <dt>Service</dt>
      <dd id="service-name">…</dd>
      <button class="copy" data-target="service-name" data-what="Nom du service" type="button">Copier</button>

      <dt>Mot de passe</dt>
      <dd id="password">…</dd>
      <button class="copy" data-target="password" data-what="Mot de passe" type="button">Copier</button>
    </dl>
  </section>

  <ol class="steps" id="steps">${steps}</ol>

  <div class="status">
    <span class="current" id="current-state">Préparation…</span>
    <span class="countdown" id="countdown" hidden></span>
  </div>

  <div class="notice" id="notice" hidden>
    <span id="notice-text"></span>
    <span class="hint" id="notice-hint" hidden></span>
  </div>

  <div class="actions" id="actions-running">
    <button class="action secondary" id="manual" type="button">Saisir l'adresse manuellement</button>
    <button class="action secondary" id="cancel" type="button">Annuler</button>
  </div>

  <div class="actions" id="actions-failed" hidden>
    <button class="action" id="retry" type="button">Réessayer</button>
  </div>
</main>
<script nonce="${nonce}" src="${this.uri('qr.js').toString()}"></script>
</body>
</html>`;
  }

  dispose(): void {
    QrPanel.current = undefined;
    this.session?.cancel('Panneau fermé.');
    this.unsubscribe?.();
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}

/** Demande une adresse `ip:port`, avec validation à la frappe. */
export async function promptForAddress(
  prompt = "Adresse d'association affichée sur le téléphone",
): Promise<HostPort | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'TIALAO ADB — adresse de l’appareil',
    prompt,
    placeHolder: '192.168.1.42:41234',
    ignoreFocusOut: true,
    validateInput: (input) =>
      input.trim().length === 0 || parseHostPort(input)
        ? undefined
        : 'Format attendu : adresse IP, deux-points, port. Exemple : 192.168.1.42:41234',
  });
  if (!value) return undefined;
  return parseHostPort(value) ?? undefined;
}
