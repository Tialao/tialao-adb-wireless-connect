// @ts-check
/**
 * Script du panneau d'association.
 *
 * Contraintes CSP : aucun style inline sur les éléments, aucune ressource externe. La
 * seule valeur dynamique (progression de l'étape courante) passe par une balise `<style>`
 * porteuse du nonce.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    qrFrame: /** @type {HTMLElement} */ (document.getElementById('qr-frame')),
    serviceName: /** @type {HTMLElement} */ (document.getElementById('service-name')),
    password: /** @type {HTMLElement} */ (document.getElementById('password')),
    revealPassword: /** @type {HTMLElement} */ (document.getElementById('reveal-password')),
    current: /** @type {HTMLElement} */ (document.getElementById('current-state')),
    countdown: /** @type {HTMLElement} */ (document.getElementById('countdown')),
    result: /** @type {HTMLElement} */ (document.getElementById('result')),
    resultDisconnect: /** @type {HTMLElement} */ (document.getElementById('result-disconnect')),
    resultTitle: /** @type {HTMLElement} */ (document.getElementById('result-title')),
    resultDetail: /** @type {HTMLElement} */ (document.getElementById('result-detail')),
    steps: /** @type {HTMLElement} */ (document.getElementById('steps')),
    manual: /** @type {HTMLElement} */ (document.getElementById('manual-backdrop')),
    manualInput: /** @type {HTMLInputElement} */ (document.getElementById('manual-address')),
    manualError: /** @type {HTMLElement} */ (document.getElementById('manual-error')),
    actionsRunning: /** @type {HTMLElement} */ (document.getElementById('actions-running')),
    actionsFailed: /** @type {HTMLElement} */ (document.getElementById('actions-failed')),
    codeForm: /** @type {HTMLElement} */ (document.getElementById('code-backdrop')),
    devicesModal: /** @type {HTMLElement} */ (document.getElementById('devices-backdrop')),
    deviceList: /** @type {HTMLElement} */ (document.getElementById('device-list')),
    disconnectModal: /** @type {HTMLElement} */ (document.getElementById('disconnect-backdrop')),
    disconnectList: /** @type {HTMLElement} */ (document.getElementById('disconnect-list')),
    codeAddress: /** @type {HTMLInputElement} */ (document.getElementById('code-address')),
    codeValue: /** @type {HTMLInputElement} */ (document.getElementById('code-value')),
    codeError: /** @type {HTMLElement} */ (document.getElementById('code-error')),
    qrCard: /** @type {HTMLElement} */ (document.querySelector('.qr-card')),
    progress: /** @type {HTMLStyleElement} */ (document.getElementById('progress-style')),
  };

  const STEP_ORDER = ['scan', 'pairing', 'connecting', 'connected'];

  /** Mot de passe en clair, gardé à part pour pouvoir le masquer sans le perdre. */
  let passwordValue = '';
  let passwordVisible = false;

  function renderPassword() {
    if (!passwordValue) return;
    el.password.textContent = passwordVisible ? passwordValue : '•'.repeat(passwordValue.length);
    el.password.classList.toggle('is-hidden', !passwordVisible);
    el.revealPassword.textContent = passwordVisible ? '🙈' : '👁';
    el.revealPassword.title = passwordVisible ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
  }

  function setStep(step) {
    const index = STEP_ORDER.indexOf(step);
    el.steps.querySelectorAll('.step').forEach((item, i) => {
      item.classList.toggle('is-done', i < index || step === 'connected');
      item.classList.toggle('is-active', i === index && step !== 'connected');
    });
  }

  /** La progression passe par une variable CSS réécrite dans une balise noncée. */
  function setProgress(ratio) {
    const clamped = Math.max(0.06, Math.min(1, ratio));
    el.progress.textContent = `:root { --tadb-progress: ${clamped.toFixed(3)}; }`;
  }

  function showResult(kind, title, detail) {
    el.result.hidden = false;
    // Deconnecter n'a de sens que si l'appareil est effectivement connecte.
    el.resultDisconnect.hidden = kind !== 'success';
    el.result.classList.toggle('is-success', kind === 'success');
    el.result.classList.toggle('is-error', kind === 'error');
    el.result.classList.toggle('is-warn', kind === 'warn');
    el.resultTitle.textContent = title;
    el.resultDetail.textContent = detail || '';
    el.resultDetail.hidden = !detail;
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /* --------------------------------------------------------------- Interactions */

  el.revealPassword.addEventListener('click', () => {
    passwordVisible = !passwordVisible;
    renderPassword();
  });

  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', () => {
      // On envoie seulement QUOI copier : l'extension lit la valeur dans ses propres
      // identifiants, ce qui ôte au webview toute influence sur le presse-papiers.
      vscode.postMessage({
        type: 'copy',
        target: button.getAttribute('data-target') === 'password' ? 'password' : 'service',
      });
      button.classList.add('is-done');
      const previous = button.textContent;
      button.textContent = '✓';
      setTimeout(() => {
        button.textContent = previous;
        button.classList.remove('is-done');
      }, 1200);
    });
  }

  // Boutons de commandes : traités par l'extension, qui exécute la commande VS Code.
  // Seule exception, « show-code-form », qui ouvre un formulaire local plutôt que de
  // passer par les boîtes de saisie natives, dont la largeur n'est pas modifiable.
  for (const button of document.querySelectorAll('[data-command]')) {
    button.addEventListener('click', () => {
      const command = button.getAttribute('data-command');
      if (command === 'show-code-form') {
        openModal(el.codeForm);
        el.codeAddress.focus();
        // L'adresse est publiée en mDNS dès l'ouverture de l'écran sur le téléphone :
        // autant la proposer plutôt que de la faire recopier.
        vscode.postMessage({ type: 'detect-address' });
        return;
      }
      if (command === 'show-devices') {
        openModal(el.devicesModal);
        listTarget = 'devices';
        renderDevices(null);
        vscode.postMessage({ type: 'list-devices' });
        return;
      }
      if (command === 'show-disconnect') {
        openModal(el.disconnectModal);
        listTarget = 'disconnect';
        renderDevices(null);
        vscode.postMessage({ type: 'list-devices' });
        return;
      }
      vscode.postMessage({ type: 'command', command });
    });
  }

  /* --------------------------------------------------------------- Modales */

  /** Une seule fenêtre à la fois : ouvrir l'une referme les autres. */
  function openModal(target) {
    for (const backdrop of document.querySelectorAll('.backdrop')) {
      backdrop.hidden = backdrop !== target;
    }
  }

  function closeModals() {
    for (const backdrop of document.querySelectorAll('.backdrop')) backdrop.hidden = true;
  }

  // Clic hors de la fenêtre, ou Échap : fermeture, comme partout ailleurs.
  for (const backdrop of document.querySelectorAll('.backdrop')) {
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) closeModals();
    });
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModals();
  });

  /** Fenêtre qui attend la prochaine liste : « devices » ou « disconnect ». */
  let listTarget = 'devices';

  /** `null` affiche l'état de recherche, un tableau vide l'absence d'appareil. */
  function renderDevices(devices) {
    const host = listTarget === 'disconnect' ? el.disconnectList : el.deviceList;
    host.textContent = '';

    const placeholder = (text) => {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = text;
      host.appendChild(li);
    };

    if (devices === null) return placeholder('Recherche…');
    if (devices.length === 0) return placeholder('Aucun appareil connecté.');

    for (const device of devices) {
      const li = document.createElement('li');
      li.classList.add(device.state === 'device' ? 'is-online' : 'is-warn');

      const dot = document.createElement('span');
      dot.className = 'dot';

      const info = document.createElement('span');
      info.className = 'info';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = device.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = device.transport + ' · ' + device.state + ' · ' + device.serial;
      info.append(name, meta);

      li.append(dot, info);

      // Dans la fenêtre de déconnexion, chaque ligne porte sa propre action.
      if (listTarget === 'disconnect' && device.transport !== 'USB') {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'row-action';
        action.textContent = 'Déconnecter';
        action.addEventListener('click', () => {
          closeModals();
          vscode.postMessage({
            type: 'disconnect',
            label: device.name,
            ...(device.address ? { address: device.address } : {}),
          });
        });
        li.appendChild(action);
      }

      host.appendChild(li);
    }
  }

  document.getElementById('disconnect-cancel')?.addEventListener('click', closeModals);
  document.getElementById('disconnect-all')?.addEventListener('click', () => {
    closeModals();
    // Sans adresse, `adb disconnect` agit sur tous les appareils sans fil.
    vscode.postMessage({ type: 'disconnect', label: 'Tous les appareils Wi-Fi' });
  });

  document.getElementById('devices-refresh')?.addEventListener('click', () => {
    listTarget = 'devices';
    renderDevices(null);
    vscode.postMessage({ type: 'list-devices' });
  });
  document.getElementById('devices-close')?.addEventListener('click', closeModals);

  /* --------------------------------------------------------- Code d'association */

  document.getElementById('code-detect')?.addEventListener('click', () => {
    el.codeError.textContent = 'Recherche sur le réseau…';
    vscode.postMessage({ type: 'detect-address' });
  });

  document.getElementById('code-cancel')?.addEventListener('click', closeModals);

  function submitPairCode() {
    const address = el.codeAddress.value.trim();
    const code = el.codeValue.value.trim();
    const match = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(address);
    const port = match ? Number(match[2]) : 0;

    if (!match || port < 1 || port > 65535) {
      el.codeError.textContent = 'Adresse attendue au format adresse:port.';
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      el.codeError.textContent = 'Le code doit comporter exactement six chiffres.';
      return;
    }

    el.codeError.textContent = '';
    closeModals();
    vscode.postMessage({ type: 'pair-code', host: match[1], port, code });
  }

  document.getElementById('code-submit')?.addEventListener('click', submitPairCode);
  for (const input of [el.codeAddress, el.codeValue]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submitPairCode();
    });
  }

  document.getElementById('cancel')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
  document.getElementById('retry')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'retry' });
  });

  document.getElementById('show-manual')?.addEventListener('click', () => {
    openModal(el.manual);
    el.manualInput.focus();
  });
  document.getElementById('manual-cancel')?.addEventListener('click', closeModals);

  function submitManual() {
    const value = el.manualInput.value.trim();
    // Validation locale : IPv4 ou nom d'hôte, suivi de deux-points et d'un port.
    const match = /^([A-Za-z0-9._-]+):(\d{1,5})$/.exec(value);
    const port = match ? Number(match[2]) : 0;
    if (!match || port < 1 || port > 65535) {
      el.manualError.textContent = 'Format attendu : adresse:port, par exemple 192.168.1.42:41234';
      return;
    }
    el.manualError.textContent = '';
    closeModals();
    vscode.postMessage({ type: 'manual', host: match[1], port });
  }

  document.getElementById('manual-submit')?.addEventListener('click', submitManual);
  el.manualInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitManual();
  });

  /* --------------------------------------------------------------- Messages */

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'qr':
        // Le SVG est produit par l'extension elle-même, pas par une source distante.
        el.qrFrame.innerHTML = message.svg;
        el.qrFrame.classList.remove('is-spent');
        el.serviceName.textContent = message.credentials.serviceName;
        passwordValue = message.credentials.password;
        passwordVisible = false;
        renderPassword();
        el.result.hidden = true;
        el.actionsRunning.hidden = false;
        el.actionsFailed.hidden = true;
        break;

      case 'state':
        el.current.textContent = message.label;
        setStep(message.step);
        if (message.step !== 'scan') {
          el.qrFrame.classList.add('is-spent');
          el.countdown.hidden = true;
        }
        break;

      case 'countdown':
        el.countdown.hidden = false;
        el.countdown.textContent = `${formatRemaining(message.remainingMs)} restantes`;
        setProgress(1 - message.remainingMs / message.totalMs);
        break;

      case 'notice':
        showResult('warn', message.message, message.hint);
        break;

      case 'failed':
        el.current.textContent = 'Échec';
        el.countdown.hidden = true;
        el.qrFrame.classList.add('is-spent');
        showResult('error', message.message, message.hint);
        el.actionsRunning.hidden = true;
        el.actionsFailed.hidden = false;
        break;

      case 'detected-address':
        if (message.address) {
          el.codeAddress.value = message.address;
          el.codeError.textContent = '';
          el.codeValue.focus();
        } else {
          el.codeError.textContent =
            "Aucun écran d'association détecté. Ouvrez-le sur le téléphone, ou saisissez l'adresse.";
        }
        break;

      case 'devices':
        renderDevices(message.devices);
        break;

      case 'mode':
        // En mode « code », le QR n'a plus lieu d'être affiché.
        el.qrCard.hidden = message.mode === 'code';
        break;

      case 'connected':
        setStep('connected');
        el.current.textContent = 'Terminé';
        el.countdown.hidden = true;
        el.qrFrame.classList.add('is-spent');
        showResult('success', message.label, message.detail);
        el.actionsRunning.hidden = true;
        el.actionsFailed.hidden = true;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
