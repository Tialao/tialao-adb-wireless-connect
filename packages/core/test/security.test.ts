import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { adaptForWindowsShim, redactSecrets } from '../src/adb.ts';
import { parseHostPort } from '../src/parse.ts';

const IS_WINDOWS = process.platform === 'win32';

describe('parseHostPort : filtre des caracteres', () => {
  // Ces valeurs sont interpretees par cmd.exe. Sans filtre, elles atteignaient un
  // shim adb .cmd et provoquaient une injection de commande.
  const INJECTIONS = [
    '1.2.3.4&calc.exe:5555',
    '1.2.3.4|whoami:5555',
    '1.2.3.4;id:5555',
    '%USERPROFILE%:5555',
    'a^b:5555',
    '1.2.3.4>out.txt:5555',
    '1.2.3.4<in.txt:5555',
    '$(id):5555',
    '`id`:5555',
    'hote avec espace:5555',
    "quote'injection:5555",
    'quote"injection:5555',
  ];

  for (const value of INJECTIONS) {
    test(`rejette ${JSON.stringify(value)}`, () => {
      assert.equal(parseHostPort(value), null);
    });
  }

  test('un hote commencant par un tiret est rejete (adb y verrait une option)', () => {
    assert.equal(parseHostPort('-a:5555'), null);
    assert.equal(parseHostPort('--foo:5555'), null);
  });

  test('les adresses legitimes restent acceptees', () => {
    assert.deepEqual(parseHostPort('192.168.1.42:41234'), { host: '192.168.1.42', port: 41234 });
    assert.deepEqual(parseHostPort('mon-telephone.local:5555'), {
      host: 'mon-telephone.local',
      port: 5555,
    });
    assert.deepEqual(parseHostPort('[fe80::1]:5555'), { host: 'fe80::1', port: 5555 });
    // La zone d'interface d'une IPv6 est legitime et doit passer.
    assert.deepEqual(parseHostPort('[fe80::1%wlan0]:41234'), {
      host: 'fe80::1%wlan0',
      port: 41234,
    });
  });

  test('une IPv6 bracketee contenant une injection est rejetee', () => {
    assert.equal(parseHostPort('[fe80::1&calc]:5555'), null);
    assert.equal(parseHostPort('[../../etc/passwd]:5555'), null);
  });

  test('un hote demesure est rejete', () => {
    assert.equal(parseHostPort(`${'a'.repeat(300)}:5555`), null);
  });
});

describe('adaptForWindowsShim', () => {
  test('hors shim, les arguments passent tels quels', () => {
    const [bin, args] = adaptForWindowsShim('adb', ['connect', '1.2.3.4:5555']);
    assert.equal(bin, 'adb');
    assert.deepEqual(args, ['connect', '1.2.3.4:5555']);
  });

  test(
    'REGRESSION : tout argument est mis entre guillemets, meme sans espace',
    { skip: !IS_WINDOWS },
    () => {
      // La version fautive ne citait que si l'argument contenait un espace ou un
      // guillemet : « 1.2.3.4&calc.exe » traversait nu et cmd.exe executait calc.exe.
      const [, args] = adaptForWindowsShim('adb.cmd', ['connect', '1.2.3.4&calc.exe:5555']);
      const line = args[3] ?? '';
      assert.match(line, /"1\.2\.3\.4&calc\.exe:5555"/);
      assert.doesNotMatch(line, /(^| )1\.2\.3\.4&/);
    },
  );

  test('les guillemets internes sont doubles', { skip: !IS_WINDOWS }, () => {
    const [, args] = adaptForWindowsShim('adb.cmd', ['x"y']);
    assert.match(args[3] ?? '', /"x""y"/);
  });

  test(
    'un argument contenant % est REFUSE : cmd le developpe malgre les guillemets',
    { skip: !IS_WINDOWS },
    () => {
      assert.throws(() => adaptForWindowsShim('adb.cmd', ['connect', '%USERPROFILE%']), /%/);
    },
  );
});

describe('redactSecrets : ancrage sur la position du verbe', () => {
  test('un argument valant « pair » ne deplace pas le masquage', () => {
    // `indexOf('pair')` aurait masque le mauvais element ici.
    const out = redactSecrets(['connect', 'pair', 'autre']);
    assert.deepEqual(out, ['connect', 'pair', 'autre']);
  });

  test('masque bien apres un selecteur -s', () => {
    const out = redactSecrets(['-s', 'SERIAL', 'pair', '10.0.0.2:5555', 'SECRET']);
    assert.doesNotMatch(out.join(' '), /SECRET/);
  });
});
