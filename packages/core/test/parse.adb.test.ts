import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHostPort,
  parseAdbVersion,
  parseConnectOutput,
  parseDeviceIp,
  parseHostPort,
  parsePairOutput,
} from '../src/parse.ts';
import { fixture, makeExec } from './helpers.ts';

describe('parseHostPort', () => {
  test('IPv4 avec port', () => {
    assert.deepEqual(parseHostPort('192.168.95.90:37123'), {
      host: '192.168.95.90',
      port: 37123,
    });
  });

  test('IPv6 bracketee avec zone', () => {
    assert.deepEqual(parseHostPort('[fe80::1%wlan0]:41234'), {
      host: 'fe80::1%wlan0',
      port: 41234,
    });
  });

  test('ponctuation finale toleree (adb termine parfois par un point)', () => {
    assert.deepEqual(parseHostPort('192.168.95.90:37123.'), {
      host: '192.168.95.90',
      port: 37123,
    });
  });

  test('sans port : rejete', () => {
    assert.equal(parseHostPort('192.168.95.90'), null);
  });

  test('IPv6 non bracketee sans port : rejetee plutot que mal decoupee', () => {
    assert.equal(parseHostPort('fe80::1c2d:3e4f'), null);
  });

  test('port hors bornes : rejete', () => {
    assert.equal(parseHostPort('192.168.95.90:70000'), null);
    assert.equal(parseHostPort('192.168.95.90:0'), null);
  });

  test('formatHostPort re-brackete l IPv6', () => {
    assert.equal(formatHostPort({ host: 'fe80::1', port: 5555 }), '[fe80::1]:5555');
    assert.equal(formatHostPort({ host: '10.0.0.2', port: 5555 }), '10.0.0.2:5555');
  });
});

describe('parsePairOutput', () => {
  test('succes avec guid : adresse et serial USB extraits', () => {
    const r = parsePairOutput(
      makeExec({
        stdout: 'Successfully paired to 192.168.95.90:41234 [guid=adb-RZGL111VD2M-abc123]\n',
      }),
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.address, { host: '192.168.95.90', port: 41234 });
    assert.equal(r.guid, 'adb-RZGL111VD2M-abc123');
    assert.equal(r.usbSerial, 'RZGL111VD2M');
  });

  test('succes sans guid', () => {
    const r = parsePairOutput(makeExec({ stdout: 'Successfully paired to 192.168.95.90:41234\n' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.address, { host: '192.168.95.90', port: 41234 });
    assert.equal(r.guid, undefined);
  });

  test('PIEGE : code de sortie 0 mais "Failed:" sur stdout => echec', () => {
    const r = parsePairOutput(makeExec({ stdout: 'Failed: Wrong password\n', code: 0 }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wrong-password');
  });

  test('mot de passe errone : non reessayable', () => {
    const r = parsePairOutput(makeExec({ stdout: 'Failed: Wrong password\n' }));
    assert.equal(r.retryable, false);
  });

  test('echec transitoire du client de pairing : reessayable', () => {
    const r = parsePairOutput(makeExec({ stdout: 'Failed: Unable to start pairing client.\n' }));
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.equal(r.reason, 'unknown');
  });

  test('connexion refusee : reessayable', () => {
    const r = parsePairOutput(makeExec({ stderr: 'failed to connect: Connection refused\n' }));
    assert.equal(r.reason, 'refused');
    assert.equal(r.retryable, true);
  });

  test('timeout du process', () => {
    const r = parsePairOutput(makeExec({ timedOut: true, code: null }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
  });

  test('sortie vide : echec explicite plutot que succes silencieux', () => {
    const r = parsePairOutput(makeExec({}));
    assert.equal(r.ok, false);
    assert.ok(r.message.length > 0);
  });

  test('le bruit du daemon ne masque pas le succes', () => {
    const r = parsePairOutput(
      makeExec({
        stdout:
          '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nSuccessfully paired to 192.168.95.90:41234 [guid=adb-RZGL111VD2M-abc123]\n',
      }),
    );
    assert.equal(r.ok, true);
    assert.equal(r.usbSerial, 'RZGL111VD2M');
  });
});

describe('parseConnectOutput', () => {
  test('connexion reussie', () => {
    const r = parseConnectOutput(makeExec({ stdout: 'connected to 192.168.95.90:37123\n' }));
    assert.equal(r.ok, true);
    assert.equal(r.alreadyConnected, false);
    assert.deepEqual(r.address, { host: '192.168.95.90', port: 37123 });
  });

  test('"already connected" est un SUCCES (auto-connect mDNS d adb)', () => {
    const r = parseConnectOutput(makeExec({ stdout: 'already connected to 192.168.95.90:37123\n' }));
    assert.equal(r.ok, true);
    assert.equal(r.alreadyConnected, true);
    assert.deepEqual(r.address, { host: '192.168.95.90', port: 37123 });
  });

  test('PIEGE : code de sortie 0 mais "failed to connect" => echec', () => {
    const r = parseConnectOutput(
      makeExec({
        stdout: "failed to connect to '192.168.95.90:37123': Connection refused\n",
        code: 0,
      }),
    );
    assert.equal(r.ok, false);
  });

  test('hote injoignable', () => {
    const r = parseConnectOutput(
      makeExec({ stderr: "failed to connect to '10.0.0.9:5555': No route to host\n" }),
    );
    assert.equal(r.ok, false);
  });

  test('sortie vide : echec explicite', () => {
    assert.equal(parseConnectOutput(makeExec({})).ok, false);
  });
});

describe('parseDeviceIp', () => {
  test('la ligne `ip route` reellement observee : IP prise apres `src`', () => {
    assert.equal(parseDeviceIp(fixture('ip-route.txt')), '192.168.95.90');
  });

  test('CRLF : meme resultat', () => {
    assert.equal(parseDeviceIp(fixture('ip-route.crlf.txt')), '192.168.95.90');
  });

  test('routes multiples : wlan0 prioritaire sur les donnees mobiles', () => {
    // Sans cette priorite on renverrait l IP rmnet, injoignable depuis le poste.
    assert.equal(parseDeviceIp(fixture('ip-route-multi.txt')), '192.168.95.90');
  });

  test('repli sur `ip addr` quand `ip route` ne donne rien', () => {
    assert.equal(parseDeviceIp('', fixture('ip-addr-wlan0.txt')), '192.168.95.90');
  });

  test('interface absente : null', () => {
    assert.equal(parseDeviceIp('', fixture('ip-addr-missing.txt')), null);
  });

  test('aucune source exploitable : null', () => {
    assert.equal(parseDeviceIp(''), null);
  });

  test('loopback ignoree', () => {
    assert.equal(parseDeviceIp('', '    inet 127.0.0.1/8 scope host lo\n'), null);
  });
});

describe('parseAdbVersion', () => {
  test('sortie reelle de adb 35.0.2 sous Windows', () => {
    const v = parseAdbVersion(fixture('adb-version.txt'));
    assert.equal(v.version, '1.0.41');
    assert.equal(v.revision, '35.0.2-12147458');
    assert.equal(v.installedAs, 'C:\\src\\scrcpy\\adb.exe');
  });

  test('CRLF : meme resultat', () => {
    const v = parseAdbVersion(fixture('adb-version.crlf.txt'));
    assert.equal(v.version, '1.0.41');
    assert.equal(v.revision, '35.0.2-12147458');
  });

  test('sortie inattendue : version "inconnue" plutot qu une exception', () => {
    assert.equal(parseAdbVersion('bonjour').version, 'inconnue');
  });
});
