// @ts-check
/**
 * Miroir d'écran : décodage H.264 par WebCodecs, rendu sur canvas, contrôle à la souris
 * et au clavier, cadre redimensionnable par poignées.
 *
 * Le flux arrive en Annex B. `VideoDecoder` a besoin des paramètres SPS/PPS avant toute
 * image : on mémorise donc le dernier paquet de configuration et on le préfixe à l'image
 * clé suivante, ce qui permet aussi de reprendre le décodage après une erreur.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    canvas: /** @type {HTMLCanvasElement} */ (document.getElementById('screen')),
    viewport: /** @type {HTMLElement} */ (document.getElementById('viewport')),
    stage: /** @type {HTMLElement} */ (document.getElementById('stage')),
    status: /** @type {HTMLElement} */ (document.getElementById('status')),
    stats: /** @type {HTMLElement} */ (document.getElementById('stats')),
    placeholder: /** @type {HTMLElement} */ (document.getElementById('placeholder')),
    zoomLabel: /** @type {HTMLElement} */ (document.getElementById('zoom-label')),
    sizeStyle: /** @type {HTMLStyleElement} */ (document.getElementById('size-style')),
  };

  const ctx = el.canvas.getContext('2d', { alpha: false, desynchronized: true });

  /** @type {VideoDecoder | null} */
  let decoder = null;
  /** @type {Uint8Array | null} */
  let pendingConfig = null;
  let codec = 'avc1.64001f';
  let source = { width: 0, height: 0 };
  let awaitingKeyFrame = true;

  let bytesReceived = 0;
  let lastStatsAt = performance.now();
  let framesSinceStats = 0;
  // Compteurs de diagnostic : sans console accessible dans un webview, c'est le
  // seul moyen de savoir si le blocage est en amont (aucun paquet) ou au décodage.
  let packetsReceived = 0;
  let framesDecoded = 0;
  let decoderState = 'non initialisé';

  /** Renvoie une trace à l'extension, qui la consigne dans le journal. */
  function report(message) {
    vscode.postMessage({ type: 'diag', message });
  }

  /** Taille d'affichage courante, en pixels CSS. */
  let view = { width: 0, height: 0 };
  /** Vrai tant que l'utilisateur n'a pas redimensionné à la main. */
  let autoFit = true;

  const MIN_VIEW_WIDTH = 120;

  const setStatus = (text) => {
    el.status.textContent = text;
  };

  /* ----------------------------------------------------------------- Dimensionnement */

  /**
   * Applique la taille du cadre. Elle passe par une variable CSS réécrite dans une
   * balise `<style>` noncée : la CSP interdit les styles inline sur les éléments.
   */
  function applyViewSize() {
    el.sizeStyle.textContent = `:root { --tadb-view-width: ${Math.round(view.width)}px; --tadb-view-height: ${Math.round(view.height)}px; }`;
    const zoom = source.width > 0 ? Math.round((view.width / source.width) * 100) : 100;
    el.zoomLabel.textContent = `${zoom}%`;
  }

  /** Plus grande taille respectant le ratio qui tienne entièrement dans la scène. */
  function fittedSize() {
    const style = getComputedStyle(el.stage);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const availableWidth = Math.max(MIN_VIEW_WIDTH, el.stage.clientWidth - padX);
    const availableHeight = Math.max(MIN_VIEW_WIDTH, el.stage.clientHeight - padY);
    const scale = Math.min(availableWidth / source.width, availableHeight / source.height);
    return { width: source.width * scale, height: source.height * scale };
  }

  function fitToStage() {
    if (source.width === 0 || source.height === 0) return;
    view = fittedSize();
    applyViewSize();
  }

  /** Contraint une largeur au ratio de l'appareil et aux limites de la scène. */
  function setViewWidth(width) {
    const ratio = source.height / source.width;
    const style = getComputedStyle(el.stage);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const maxHeight = el.stage.clientHeight - padY;
    const maxWidth = Math.min(el.stage.clientWidth * 3, maxHeight / ratio * 3);

    const clamped = Math.max(MIN_VIEW_WIDTH, Math.min(width, maxWidth));
    view = { width: clamped, height: clamped * ratio };
    applyViewSize();
  }

  // Le cadre suit la taille du panneau tant que l'utilisateur n'a pas repris la main.
  new ResizeObserver(() => {
    if (autoFit) fitToStage();
  }).observe(el.stage);

  /* ----------------------------------------------------------------- Poignées */

  let resizing = null;

  for (const handle of document.querySelectorAll('.handle')) {
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resizing = {
        edge: handle.getAttribute('data-edge') || 'se',
        startX: event.clientX,
        startY: event.clientY,
        startWidth: view.width,
        startHeight: view.height,
      };
      autoFit = false;
      el.viewport.classList.add('is-resizing');
    });
  }

  window.addEventListener('mousemove', (event) => {
    if (!resizing) return;
    const dx = event.clientX - resizing.startX;
    const dy = event.clientY - resizing.startY;
    const edge = resizing.edge;

    // Le cadre est centré : tirer un bord l'élargit des DEUX côtés, d'où le facteur 2.
    // Sans lui, l'écran semblerait fuir sous le curseur.
    let width = resizing.startWidth;
    if (edge.includes('e')) width = resizing.startWidth + dx * 2;
    else if (edge.includes('w')) width = resizing.startWidth - dx * 2;
    else if (edge.includes('s')) width = ((resizing.startHeight + dy * 2) * source.width) / source.height;
    else if (edge.includes('n')) width = ((resizing.startHeight - dy * 2) * source.width) / source.height;

    setViewWidth(width);
  });

  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = null;
    el.viewport.classList.remove('is-resizing');
  });

  /* ----------------------------------------------------------------- Décodage */

  function createDecoder() {
    closeDecoder();
    decoder = new VideoDecoder({
      output: (frame) => {
        framesSinceStats += 1;
        framesDecoded += 1;
        if (el.canvas.width !== frame.displayWidth || el.canvas.height !== frame.displayHeight) {
          el.canvas.width = frame.displayWidth;
          el.canvas.height = frame.displayHeight;
        }
        ctx?.drawImage(frame, 0, 0);
        frame.close();
        if (!el.placeholder.hidden) {
          el.placeholder.hidden = true;
          el.viewport.hidden = false;
          fitToStage();
        }
      },
      error: (error) => {
        // Une erreur de décodage n'est pas fatale : on repart sur la prochaine image clé.
        decoderState = 'erreur : ' + error.message;
        report(`Décodeur en erreur : ${error.message}`);
        setStatus(`Décodage interrompu (${error.message}) — reprise…`);
        awaitingKeyFrame = true;
        createDecoder();
      },
    });

    try {
      decoder.configure({
        codec,
        // Le flux est en Annex B : pas de `description`, les paramètres voyagent en ligne.
        optimizeForLatency: true,
      });
      decoderState = 'configuré (' + codec + ')';
      report(`Décodeur configuré pour ${codec}.`);
    } catch (error) {
      decoderState = 'configuration refusée';
      report(`Configuration du décodeur refusée pour ${codec} : ${String(error)}`);
      setStatus(`Codec ${codec} non pris en charge par cet éditeur.`);
    }
  }

  function closeDecoder() {
    if (!decoder) return;
    try {
      if (decoder.state !== 'closed') decoder.close();
    } catch {
      /* déjà fermé */
    }
    decoder = null;
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function onPacket(bytes, isConfig, isKeyFrame, ptsUs) {
    bytesReceived += bytes.length;
    packetsReceived += 1;
    if (packetsReceived <= 3) {
      report(
        `Paquet ${String(packetsReceived)} : ${String(bytes.length)} o, config=${String(isConfig)}, cle=${String(isKeyFrame)}`,
      );
    }

    if (isConfig) {
      // SPS/PPS : mémorisés, ils seront joints à la prochaine image clé.
      pendingConfig = bytes;
      return;
    }
    if (!decoder || decoder.state !== 'configured') {
      if (packetsReceived <= 3) report(`Paquet ignoré, décodeur ${decoder ? decoder.state : 'absent'}.`);
      return;
    }

    // Tant qu'on n'a pas vu d'image clé, les images delta provoqueraient une erreur.
    if (awaitingKeyFrame && !isKeyFrame) return;

    let payload = bytes;
    if (isKeyFrame && pendingConfig) {
      payload = concat(pendingConfig, bytes);
      pendingConfig = null;
    }

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKeyFrame ? 'key' : 'delta',
          timestamp: ptsUs ?? 0,
          data: payload,
        }),
      );
      awaitingKeyFrame = false;
    } catch (error) {
      report(`decode() a levé : ${String(error)}`);
      setStatus(`Image ignorée : ${String(error)}`);
      awaitingKeyFrame = true;
    }
  }

  /* ----------------------------------------------------------------- Statistiques */

  setInterval(() => {
    const now = performance.now();
    const seconds = (now - lastStatsAt) / 1000;
    if (seconds <= 0) return;
    el.stats.textContent =
      `${source.width}×${source.height} · ${(framesSinceStats / seconds).toFixed(0)} i/s · ` +
      `${(bytesReceived / 1024 / seconds).toFixed(0)} Ko/s · ` +
      `${String(packetsReceived)} paquets, ${String(framesDecoded)} images · ${decoderState}`;
    framesSinceStats = 0;
    bytesReceived = 0;
    lastStatsAt = now;
  }, 1000);

  /* ----------------------------------------------------------------- Contrôle */

  /**
   * Convertit un point de la fenêtre vers le repère de l'image encodée.
   * Le canvas remplit exactement le cadre, qui respecte le ratio : la conversion est
   * donc une simple mise à l'échelle, sans bandes à retrancher.
   */
  function toDeviceCoords(event) {
    const rect = el.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || source.width === 0) return null;
    const x = ((event.clientX - rect.left) / rect.width) * source.width;
    const y = ((event.clientY - rect.top) / rect.height) * source.height;
    if (x < 0 || y < 0 || x > source.width || y > source.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  let pressing = false;

  el.canvas.addEventListener('mousedown', (event) => {
    const point = toDeviceCoords(event);
    if (!point) return;
    pressing = true;
    el.canvas.focus();
    vscode.postMessage({ type: 'touch', action: 'down', ...point });
  });

  window.addEventListener('mousemove', (event) => {
    if (!pressing || resizing) return;
    const point = toDeviceCoords(event);
    if (point) vscode.postMessage({ type: 'touch', action: 'move', ...point });
  });

  window.addEventListener('mouseup', (event) => {
    if (!pressing) return;
    pressing = false;
    const point = toDeviceCoords(event) ?? { x: 0, y: 0 };
    vscode.postMessage({ type: 'touch', action: 'up', ...point });
  });

  el.canvas.addEventListener(
    'wheel',
    (event) => {
      const point = toDeviceCoords(event);
      if (!point) return;
      event.preventDefault();

      // Ctrl + molette zoome le cadre, comme partout ailleurs dans l'éditeur.
      if (event.ctrlKey) {
        autoFit = false;
        setViewWidth(view.width * (event.deltaY < 0 ? 1.1 : 0.9));
        return;
      }

      vscode.postMessage({
        type: 'scroll',
        ...point,
        h: Math.max(-1, Math.min(1, -event.deltaX / 120)),
        v: Math.max(-1, Math.min(1, -event.deltaY / 120)),
      });
    },
    { passive: false },
  );

  // Correspondance clavier. Les touches d'édition et de navigation deviennent des codes
  // Android ; tout caractère imprimable part comme du texte, ce qui gère correctement
  // les accents et les dispositions non-QWERTY.
  const KEYMAP = {
    Backspace: 67,
    Enter: 66,
    Tab: 61,
    Escape: 111,
    ArrowUp: 19,
    ArrowDown: 20,
    ArrowLeft: 21,
    ArrowRight: 22,
    Home: 122,
    End: 123,
    Delete: 112,
    PageUp: 92,
    PageDown: 93,
  };

  el.canvas.addEventListener('keydown', (event) => {
    const mapped = KEYMAP[event.key];
    if (mapped !== undefined) {
      event.preventDefault();
      vscode.postMessage({ type: 'key', keycode: mapped });
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      vscode.postMessage({ type: 'text', value: event.key });
    }
  });

  for (const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-action');
      if (action === 'fit') {
        autoFit = true;
        fitToStage();
        return;
      }
      if (action === 'zoomIn' || action === 'zoomOut') {
        autoFit = false;
        setViewWidth(view.width * (action === 'zoomIn' ? 1.15 : 0.87));
        return;
      }
      vscode.postMessage({ type: 'action', action });
    });
  }

  /* ----------------------------------------------------------------- Messages */

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'status':
        setStatus(message.message);
        break;

      case 'ready':
        source = { width: message.width, height: message.height };
        codec = message.codec || codec;
        awaitingKeyFrame = true;
        pendingConfig = null;
        autoFit = true;
        createDecoder();
        fitToStage();
        setStatus(`${message.deviceName} — ${message.width}×${message.height}`);
        break;

      case 'packet': {
        // Les octets voyagent en base64 : `postMessage` d'un webview sérialise en JSON,
        // et un Uint8Array y deviendrait un objet indexé, ruineux en performance.
        const binary = atob(message.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        onPacket(bytes, message.isConfig, message.isKeyFrame, message.ptsUs);
        break;
      }

      case 'closed':
        closeDecoder();
        el.viewport.hidden = true;
        el.placeholder.hidden = false;
        el.placeholder.textContent = message.reason;
        setStatus('Miroir arrêté');
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
