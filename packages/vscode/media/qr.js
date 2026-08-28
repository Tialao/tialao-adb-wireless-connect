// @ts-check
/**
 * Script du panneau d'association.
 *
 * Contraintes CSP : aucun style inline, aucune ressource externe. Les valeurs
 * dynamiques (progression de l'étape courante) passent par une balise <style>
 * porteuse du nonce, jamais par `element.style`.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    qrFrame: /** @type {HTMLElement} */ (document.getElementById('qr-frame')),
    serviceName: /** @type {HTMLElement} */ (document.getElementById('service-name')),
    password: /** @type {HTMLElement} */ (document.getElementById('password')),
    current: /** @type {HTMLElement} */ (document.getElementById('current-state')),
    countdown: /** @type {HTMLElement} */ (document.getElementById('countdown')),
    notice: /** @type {HTMLElement} */ (document.getElementById('notice')),
    noticeText: /** @type {HTMLElement} */ (document.getElementById('notice-text')),
    noticeHint: /** @type {HTMLElement} */ (document.getElementById('notice-hint')),
    steps: /** @type {HTMLElement} */ (document.getElementById('steps')),
    actionsRunning: /** @type {HTMLElement} */ (document.getElementById('actions-running')),
    actionsFailed: /** @type {HTMLElement} */ (document.getElementById('actions-failed')),
    progress: /** @type {HTMLStyleElement} */ (document.getElementById('progress-style')),
  };

  const STEP_ORDER = ['scan', 'pairing', 'connecting', 'connected'];

  function setStep(step) {
    const index = STEP_ORDER.indexOf(step);
    const items = el.steps.querySelectorAll('.step');
    items.forEach((item, i) => {
      item.classList.toggle('is-done', i < index || step === 'connected');
      item.classList.toggle('is-active', i === index && step !== 'connected');
    });
  }

  /** La progression passe par une variable CSS réécrite dans une balise <style> noncée. */
  function setProgress(ratio) {
    const clamped = Math.max(0.06, Math.min(1, ratio));
    el.progress.textContent = `:root { --tadb-progress: ${clamped.toFixed(3)}; }`;
  }

  function showNotice(level, message, hint) {
    el.notice.hidden = false;
    el.notice.classList.toggle('is-error', level === 'error');
    el.notice.classList.toggle('is-success', level === 'success');
    el.noticeText.textContent = message;
    el.noticeHint.textContent = hint || '';
    el.noticeHint.hidden = !hint;
  }

  function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'qr':
        // Le SVG est produit par l'extension elle-même, pas par une source distante.
        el.qrFrame.innerHTML = message.svg;
        el.serviceName.textContent = message.credentials.serviceName;
        el.password.textContent = message.credentials.password;
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
        showNotice(message.level === 'warn' ? 'error' : 'info', message.message, message.hint);
        break;

      case 'failed':
        el.current.textContent = 'Échec';
        el.countdown.hidden = true;
        el.qrFrame.classList.add('is-spent');
        showNotice('error', message.message, message.hint);
        el.actionsRunning.hidden = true;
        el.actionsFailed.hidden = false;
        break;

      case 'connected':
        setStep('connected');
        el.current.textContent = message.label;
        el.countdown.hidden = true;
        el.qrFrame.classList.add('is-spent');
        showNotice('success', message.label, message.detail);
        el.actionsRunning.hidden = true;
        el.actionsFailed.hidden = true;
        break;
    }
  });

  document.getElementById('cancel')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancel' });
  });
  document.getElementById('manual')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'manual' });
  });
  document.getElementById('retry')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'retry' });
  });

  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', () => {
      const targetId = button.getAttribute('data-target');
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target) return;
      vscode.postMessage({
        type: 'copy',
        value: target.textContent || '',
        what: button.getAttribute('data-what') || 'Valeur',
      });
      const previous = button.textContent;
      button.textContent = 'Copié';
      setTimeout(() => {
        button.textContent = previous;
      }, 1200);
    });
  }

  vscode.postMessage({ type: 'ready' });
})();
