import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {
  buildQrPayload,
  generatePairingCredentials,
  parseQrPayload,
  pickTerminalMode,
  renderQrSvg,
  renderQrTerminal,
} from '../src/qr.ts';

/** RNG déterministe : rend les identifiants reproductibles dans les tests. */
function seededRng(seed: number): (max: number) => number {
  let state = seed;
  return (max) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % max;
  };
}

describe('generatePairingCredentials', () => {
  test('respecte la convention Android Studio', () => {
    const c = generatePairingCredentials();
    assert.match(c.serviceName, /^studio-[A-Za-z0-9]{6}$/);
    assert.match(c.password, /^[A-Za-z0-9]{12}$/);
  });

  test('ne genere JAMAIS un caractere reserve par la grammaire WIFI:', () => {
    // `\ ; , : "` devraient etre echappes dans un payload WIFI:. En restant
    // strictement alphanumerique, on garantit qu'aucun echappement n'est necessaire.
    for (let i = 0; i < 500; i += 1) {
      const c = generatePairingCredentials();
      assert.doesNotMatch(c.serviceName + c.password, /[\\;,:"]/);
    }
  });

  test('deterministe avec un RNG injecte', () => {
    const a = generatePairingCredentials(seededRng(42));
    const b = generatePairingCredentials(seededRng(42));
    assert.deepEqual(a, b);
  });

  test('1000 generations sans collision', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const c = generatePairingCredentials();
      seen.add(c.serviceName + c.password);
    }
    assert.equal(seen.size, 1000);
  });
});

describe('payload QR', () => {
  test('format exact attendu par Android', () => {
    const payload = buildQrPayload({ serviceName: 'studio-Ab3xK9', password: 'DvctpD9aNKvU' });
    assert.equal(payload, 'WIFI:T:ADB;S:studio-Ab3xK9;P:DvctpD9aNKvU;;');
  });

  test('round-trip build -> parse', () => {
    for (let i = 0; i < 200; i += 1) {
      const c = generatePairingCredentials();
      assert.deepEqual(parseQrPayload(buildQrPayload(c)), c);
    }
  });

  test('payload etranger : null plutot qu une valeur inventee', () => {
    assert.equal(parseQrPayload('WIFI:T:WPA;S:MonWifi;P:secret;;'), null);
    assert.equal(parseQrPayload('nawak'), null);
  });
});

describe('renderQrSvg', () => {
  const payload = buildQrPayload({ serviceName: 'studio-Ab3xK9', password: 'DvctpD9aNKvU' });

  test('produit un SVG autonome, sans ressource externe', () => {
    const svg = renderQrSvg(payload);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
    // Aucune dependance reseau : c'est une exigence du projet.
    assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/);
    assert.doesNotMatch(svg, /<image/);
  });

  test('la marge (quiet zone) vaut 4 modules par defaut', () => {
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'Q' });
    const expected = qr.modules.size + 8;
    assert.match(renderQrSvg(payload), new RegExp(`viewBox="0 0 ${expected} ${expected}"`));
  });

  test('dessine exactement les modules de donnees, marqueurs d angle exclus', () => {
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'Q' });
    const size = qr.modules.size;
    const finders: Array<[number, number]> = [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ];
    let expected = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const inFinder = finders.some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
        if (qr.modules.data[y * size + x] === 1 && !inFinder) expected += 1;
      }
    }
    const svg = renderQrSvg(payload);
    const dataRects = (svg.match(/<rect x="\d+" y="\d+" width="1" height="1"/g) ?? []).length;
    assert.equal(dataRects, expected);
  });

  test('les 3 marqueurs d angle sont dessines : anneau 7x7 + pupille 3x3', () => {
    const svg = renderQrSvg(payload);
    // Anneau : rect 6x6 avec un trait de 1 module => couvre bien 7x7 modules.
    assert.equal((svg.match(/width="6" height="6"[^>]*stroke-width="1"/g) ?? []).length, 3);
    assert.equal((svg.match(/width="3" height="3"/g) ?? []).length, 3);
  });

  test('les couleurs ne suivent PAS le theme : un QR inverse ne se scanne pas', () => {
    const svg = renderQrSvg(payload);
    assert.match(svg, /fill="#ffffff"/);
    assert.match(svg, /fill="#0b0d12"/);
    assert.doesNotMatch(svg, /var\(--vscode/);
  });

  test('mode carre strict disponible', () => {
    assert.match(renderQrSvg(payload, { rounded: false }), /rx="0"/);
  });
});

describe('renderQrTerminal', () => {
  const payload = buildQrPayload({ serviceName: 'studio-Ab3xK9', password: 'DvctpD9aNKvU' });

  test('produit un rendu non vide dans les deux modes', async () => {
    assert.ok((await renderQrTerminal(payload, { mode: 'wide' })).length > 100);
    assert.ok((await renderQrTerminal(payload, { mode: 'compact' })).length > 100);
  });

  test('le mode compact est plus court que le mode large', async () => {
    const compact = await renderQrTerminal(payload, { mode: 'compact' });
    const wide = await renderQrTerminal(payload, { mode: 'wide' });
    assert.ok(compact.length < wide.length);
  });
});

describe('pickTerminalMode', () => {
  test('hors Windows : demi-blocs', { skip: process.platform === 'win32' }, () => {
    assert.equal(pickTerminalMode({}), 'compact');
  });

  test('Windows Terminal : demi-blocs', { skip: process.platform !== 'win32' }, () => {
    assert.equal(pickTerminalMode({ WT_SESSION: '1' }), 'compact');
  });

  test(
    'conhost nu : blocs pleins, car les demi-blocs y sortent en "?"',
    { skip: process.platform !== 'win32' },
    () => {
      assert.equal(pickTerminalMode({}), 'wide');
    },
  );
});
