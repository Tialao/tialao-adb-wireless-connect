import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  Adb,
  HostPort,
  PairingEvent,
  PairingResult,
  PairingSession,
  PairingState,
} from 'tialao-adb-wireless';
import {
  PAIRING_SERVICE_TYPE,
  dedupeDevices,
  formatHostPort,
  pairWithCode,
  parseHostPort,
  startQrPairing,
} from 'tialao-adb-wireless';
import type { HostToWebview, StepId, WebviewToHost } from './protocol.ts';
import * as config from '../config.ts';
import type { Logger } from '../logger.ts';

/**
 * Commandes que le panneau a le droit de déclencher.
 *
 * `executeCommand` accepte n'importe quelle commande de l'éditeur : sans cette liste,
 * un script injecté dans le webview pourrait en lancer une arbitraire — ouvrir un
 * terminal et y écrire, par exemple. La CSP rend l'injection très improbable, mais
 * elle ne doit pas être la seule barrière.
 */
const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'tialaoAdb.connect',
  'tialaoAdb.disconnect',
  'tialaoAdb.mirror',
  'tialaoAdb.showDevices',
  'tialaoAdb.pairCode',
  'tialaoAdb.openTerminal',
  'tialaoAdb.restartServer',
]);

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
  private session: PairingSession | undefined;
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
    this.unsubscribe?.();
    // Le HTML est régénéré : le panneau repart en mode QR, carte visible.
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
        // L'adresse est saisie dans le panneau lui-même : on maîtrise ainsi ses
        // proportions, ce que la boîte de saisie native de VS Code ne permet pas.
        // Le webview valide déjà la saisie, mais on ne lui fait pas confiance :
        // ces valeurs finissent en arguments d'un processus.
        const address = this.sanitizeAddress(message.host, message.port);
        if (address) this.session?.submitManualAddress(address);
        break;
      }

      case 'command':
        if (!ALLOWED_COMMANDS.has(message.command)) {
          this.logger.warn(`Commande refusée depuis le panneau : ${message.command}`);
          break;
        }
        await vscode.commands.executeCommand(message.command);
        break;

      case 'detect-address':
        await this.detectPairingAddress();
        break;

      case 'list-devices':
        await this.sendDeviceList();
        break;

      case 'disconnect': {
        const address = message.address
          ? this.sanitizeAddress(message.address.host, message.address.port)
          : undefined;
        // Une adresse fournie mais invalide ne doit pas se dégrader en « tout
        // déconnecter » : on refuse plutôt que d'agir plus largement que demandé.
        if (message.address && !address) {
          this.logger.warn('Déconnexion refusée : adresse invalide.');
          break;
        }
        await this.disconnectDevice(address, message.label.slice(0, 120));
        break;
      }

      case 'pair-code': {
        const address = this.sanitizeAddress(message.host, message.port);
        // Le code d'association est strictement six chiffres : tout le reste est rejeté.
        if (address && /^\d{6}$/.test(message.code)) {
          this.startCodePairing(address, message.code);
        } else {
          this.logger.warn("Association par code refusée : adresse ou code invalide.");
        }
        break;
      }

      case 'copy': {
        // La valeur vient de NOS identifiants, jamais du webview.
        const credentials = this.session?.credentials;
        if (!credentials) break;
        const isPassword = message.target === 'password';
        await vscode.env.clipboard.writeText(
          isPassword ? credentials.password : credentials.serviceName,
        );
        vscode.window.setStatusBarMessage(
          `${isPassword ? 'Mot de passe' : 'Nom du service'} copié dans le presse-papiers.`,
          2000,
        );
        break;
      }

      default:
        break;
    }
  }

  /**
   * Cherche l'adresse d'association publiée par le téléphone.
   *
   * Ouvrir l'écran « Associer avec un code » fait publier un service
   * `_adb-tls-pairing._tcp` : l'adresse est donc découvrable, et l'utilisateur n'a
   * que les six chiffres à saisir.
   */
  private async detectPairingAddress(): Promise<void> {
    try {
      const services = await this.adb.mdnsServices();
      const found = services.find((s) => s.type === PAIRING_SERVICE_TYPE);
      this.post({
        type: 'detected-address',
        address: found ? formatHostPort({ host: found.host, port: found.port }) : null,
      });
    } catch (error) {
      this.logger.warn(`Détection de l'adresse d'association impossible : ${String(error)}`);
      this.post({ type: 'detected-address', address: null });
    }
  }

  /**
   * Valide une adresse venue du webview avant de la passer à un processus.
   *
   * `parseHostPort` rejette tout ce qui n'est pas `hôte:port` plausible, ce qui écarte
   * notamment un « hôte » commençant par un tiret, qu'adb pourrait prendre pour une option.
   */
  private sanitizeAddress(host: unknown, port: unknown): HostPort | undefined {
    if (typeof host !== 'string' || typeof port !== 'number') return undefined;
    if (host.length > 255 || host.startsWith('-')) return undefined;
    return parseHostPort(`${host}:${String(port)}`) ?? undefined;
  }

  /** Envoie la liste des appareils à la fenêtre « Appareils ». */
  private async sendDeviceList(): Promise<void> {
    try {
      // Regroupe les doublons TCP/mDNS d'un même téléphone.
      const devices = dedupeDevices(await this.adb.devices());
      this.post({
        type: 'devices',
        devices: devices.map((d) => ({
          name: d.model ?? d.serial,
          serial: d.serial,
          state: d.state,
          transport: d.transport === 'usb' ? 'USB' : d.transport === 'tcp' ? 'Wi-Fi' : 'Wi-Fi (mDNS)',
          // Seule une entrée TCP porte une adresse : c'est la seule sur laquelle
          // `adb disconnect` sait agir de manière ciblée.
          ...(d.host !== undefined && d.port !== undefined
            ? { address: { host: d.host, port: d.port } }
            : {}),
        })),
      });
    } catch (error) {
      this.logger.warn(`Liste des appareils indisponible : ${String(error)}`);
      this.post({ type: 'devices', devices: [] });
    }
  }

  /** Déconnecte depuis la fenêtre de confirmation du panneau. */
  private async disconnectDevice(
    address: { host: string; port: number } | undefined,
    label: string,
  ): Promise<void> {
    try {
      await this.adb.disconnect(address);
      this.logger.info(`Déconnexion : ${label}.`);
      vscode.window.showInformationMessage(`${label} déconnecté.`);
      // La liste affichée doit refléter l'état réel juste après l'action.
      await this.sendDeviceList();
    } catch (error) {
      this.logger.error(`Déconnexion impossible : ${String(error)}`);
      vscode.window.showErrorMessage(`Déconnexion impossible : ${String(error)}`);
    }
  }

  /** Bascule le panneau sur le flux par code à six chiffres. */
  private startCodePairing(address: HostPort, code: string): void {
    // Une seule association à la fois : le flux QR en cours est abandonné.
    this.session?.cancel('Association par code demandée.');
    this.unsubscribe?.();
    this.post({ type: 'mode', mode: 'code' });

    const timeoutMs = config.discoveryTimeoutMs();
    this.logger.info(`Association par code sur ${formatHostPort(address)}.`);

    const session = pairWithCode(this.adb, address, code, { timeoutMs });
    this.session = session;
    this.unsubscribe = session.on((event) => this.handleEvent(event, timeoutMs));

    void session.done.then((result) => {
      if (result.ok) this.onSuccess(result);
    });
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

    const actions = [
      ['tialaoAdb.connect', '⊕', 'Connecter'],
      ['tialaoAdb.disconnect', '⊖', 'Déconnecter'],
      ['tialaoAdb.mirror', '▣', 'Écran'],
      ['show-devices', '≡', 'Appareils'],
      ['show-code-form', '*', 'Code'],
      ['tialaoAdb.openTerminal', '⌫', 'Terminal'],
      ['tialaoAdb.restartServer', '↻', 'Serveur'],
    ]
      .map(
        ([command, glyph, label]) =>
          `<button type="button" data-command="${command}" title="${label}"><span class="glyph">${glyph}</span><span class="label">${label}</span></button>`,
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

  <nav class="actions-bar" aria-label="Actions rapides">${actions}</nav>

  <section class="qr-card">
    <div class="qr-frame" id="qr-frame" role="img" aria-label="QR code d'association"></div>
    <p class="qr-hint">Scannez ce code depuis l'écran <strong>Débogage sans fil</strong> du téléphone.</p>

    <div class="creds">
      <div class="cred">
        <span class="name">Service</span>
        <span class="value" id="service-name">…</span>
        <button class="icon-button copy" data-target="service" data-what="Nom du service"
                type="button" title="Copier le nom du service">⧉</button>
      </div>
      <div class="cred">
        <span class="name">Mot de passe</span>
        <span class="value is-hidden" id="password">…</span>
        <button class="icon-button" id="reveal-password" type="button"
                title="Afficher le mot de passe">👁</button>
        <button class="icon-button copy" data-target="password" data-what="Mot de passe"
                type="button" title="Copier le mot de passe">⧉</button>
      </div>
    </div>
  </section>

  <ol class="steps" id="steps">${steps}</ol>

  <div class="status">
    <span class="current" id="current-state">Préparation…</span>
    <span class="countdown" id="countdown" hidden></span>
  </div>

  <div class="result" id="result" hidden>
    <span class="dot"></span>
    <div class="body">
      <span class="title" id="result-title"></span>
      <span class="detail" id="result-detail" hidden></span>
    </div>
    <button class="result-action" id="result-disconnect" type="button" hidden
            data-command="show-disconnect">Déconnecter</button>
  </div>

  <div class="backdrop" id="code-backdrop" hidden>
    <section class="modal" role="dialog" aria-label="Associer avec un code">
      <h2>Associer avec un code</h2>
      <p>Sur le téléphone : <strong>Débogage sans fil → Associer l'appareil à l'aide d'un code
         d'association</strong>. L'écran affiche une adresse et un code à six chiffres.</p>
      <div class="field">
        <label for="code-address">Adresse IP et port</label>
        <div class="field-row">
          <input id="code-address" type="text" placeholder="192.168.1.42:41234"
                 autocomplete="off" spellcheck="false" />
          <button class="icon-button" id="code-detect" type="button"
                  title="Détecter automatiquement sur le réseau">⌖</button>
        </div>
      </div>
      <div class="field">
        <label for="code-value">Code à six chiffres</label>
        <input id="code-value" type="text" inputmode="numeric" maxlength="6"
               placeholder="123456" autocomplete="off" spellcheck="false" />
        <span class="error" id="code-error"></span>
      </div>
      <div class="buttons">
        <button class="action" id="code-submit" type="button">Associer</button>
        <button class="action secondary" id="code-cancel" type="button">Annuler</button>
      </div>
    </section>
  </div>

  <div class="backdrop" id="manual-backdrop" hidden>
    <section class="modal" role="dialog" aria-label="Adresse manuelle">
      <h2>Adresse manuelle</h2>
      <p>À utiliser quand la découverte réseau ne trouve rien. L'adresse est affichée sur
         l'écran Débogage sans fil du téléphone.</p>
      <div class="field">
        <label for="manual-address">Adresse IP et port</label>
        <input id="manual-address" type="text" placeholder="192.168.1.42:41234"
               autocomplete="off" spellcheck="false" />
        <span class="error" id="manual-error"></span>
      </div>
      <div class="buttons">
        <button class="action" id="manual-submit" type="button">Utiliser</button>
        <button class="action secondary" id="manual-cancel" type="button">Annuler</button>
      </div>
    </section>
  </div>

  <div class="backdrop" id="disconnect-backdrop" hidden>
    <section class="modal" role="dialog" aria-label="Déconnecter un appareil">
      <h2>Déconnecter un appareil</h2>
      <p>L'appareil <strong>reste associé</strong> : il pourra être reconnecté sans refaire
         l'association. Les sessions de débogage en cours seront interrompues.</p>
      <ul class="device-list" id="disconnect-list"></ul>
      <div class="buttons">
        <button class="action danger" id="disconnect-all" type="button">Tout déconnecter</button>
        <button class="action secondary" id="disconnect-cancel" type="button">Annuler</button>
      </div>
    </section>
  </div>

  <div class="backdrop" id="devices-backdrop" hidden>
    <section class="modal" role="dialog" aria-label="Appareils connectés">
      <h2>Appareils connectés</h2>
      <ul class="device-list" id="device-list"></ul>
      <div class="buttons">
        <button class="action secondary" id="devices-refresh" type="button">Rafraîchir</button>
        <button class="action secondary" id="devices-close" type="button">Fermer</button>
      </div>
    </section>
  </div>

  <div class="buttons" id="actions-running">
    <button class="action secondary" id="show-manual" type="button">Saisir l'adresse</button>
    <button class="action secondary" id="cancel" type="button">Annuler</button>
  </div>

  <div class="buttons" id="actions-failed" hidden>
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
