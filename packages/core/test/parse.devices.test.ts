import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeDevices, parseDevices, usbSerialFromMdnsSerial } from '../src/parse.ts';
import { fixture } from './helpers.ts';

describe('parseDevices', () => {
  test('en-tete seul : aucun appareil', () => {
    assert.deepEqual(parseDevices(fixture('devices-empty.txt')), []);
  });

  test('chaine vide : aucun appareil, sans lever', () => {
    assert.deepEqual(parseDevices(''), []);
  });

  test('la ligne USB reellement observee (adb 35.0.2, SM-A175F)', () => {
    const [d] = parseDevices(fixture('devices-usb-l.txt'));
    assert.ok(d);
    assert.equal(d.serial, 'RZGL111VD2M');
    assert.equal(d.state, 'device');
    assert.equal(d.transport, 'usb');
    assert.equal(d.model, 'SM_A175F');
    assert.equal(d.product, 'a17xx');
    assert.equal(d.device, 'a17');
    assert.equal(d.transportId, '1');
    assert.equal(d.host, undefined);
  });

  test('les lignes de bruit du daemon sont ignorees', () => {
    const devices = parseDevices(fixture('devices-daemon-noise.txt'));
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.serial, 'RZGL111VD2M');
    assert.equal(devices[0]?.state, 'device');
  });

  test('appareil TCP : hote et port extraits du serial', () => {
    const d = parseDevices(fixture('devices-mixed-l.txt')).find(
      (x) => x.serial === '192.168.95.90:37123',
    );
    assert.ok(d);
    assert.equal(d.transport, 'tcp');
    assert.equal(d.host, '192.168.95.90');
    assert.equal(d.port, 37123);
  });

  test('serial mDNS : transport mdns et serial USB extrait', () => {
    const d = parseDevices(fixture('devices-mixed-l.txt')).find((x) => x.transport === 'mdns');
    assert.ok(d);
    assert.equal(d.serial, 'adb-RZGL111VD2M-abc123._adb-tls-connect._tcp.');
    assert.equal(d.usbSerial, 'RZGL111VD2M');
    assert.equal(d.state, 'device');
    // Un serial mDNS n'est pas une adresse : ne pas en deduire un hote.
    assert.equal(d.host, undefined);
  });

  test('etats offline et unauthorized', () => {
    const devices = parseDevices(fixture('devices-mixed-l.txt'));
    assert.equal(devices.find((d) => d.serial === 'emulator-5554')?.state, 'offline');
    assert.equal(devices.find((d) => d.serial === '0123456789ABCDEF')?.state, 'unauthorized');
  });

  test('"no permissions (...)" : etat multi-mots, et son URL ne pollue pas les proprietes', () => {
    const d = parseDevices(fixture('devices-mixed-l.txt')).find(
      (x) => x.serial === 'FA69ABCDEFGH',
    );
    assert.ok(d);
    assert.equal(d.state, 'no permissions');
    // "http://developer.android.com/..." contient un ':' : un decoupage naif sur ':'
    // en aurait fait une propriete.
    assert.equal(d.model, undefined);
    assert.equal(d.product, undefined);
  });

  test('CRLF : la variante Windows donne exactement le meme resultat que la variante LF', () => {
    const lf = parseDevices(fixture('devices-mixed-l.txt'));
    const crlf = parseDevices(fixture('devices-mixed-l.crlf.txt'));
    assert.deepEqual(crlf, lf);
    // Garde-fou : un '\r' residuel casserait le port en silence.
    assert.equal(crlf.find((d) => d.transport === 'tcp')?.port, 37123);
  });

  test('forme courte `adb devices` (sans -l)', () => {
    const devices = parseDevices('List of devices attached\nRZGL111VD2M\tdevice\n');
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.state, 'device');
    assert.equal(devices[0]?.transportId, undefined);
  });

  test('etat inconnu plutot que de lever', () => {
    const devices = parseDevices('List of devices attached\nSERIAL123\tsomething-new\n');
    assert.equal(devices[0]?.state, 'unknown');
  });
});

describe('usbSerialFromMdnsSerial', () => {
  test('instance mDNS complete', () => {
    assert.equal(
      usbSerialFromMdnsSerial('adb-RZGL111VD2M-abc123._adb-tls-connect._tcp.'),
      'RZGL111VD2M',
    );
  });

  test('guid nu renvoye par adb pair', () => {
    assert.equal(usbSerialFromMdnsSerial('adb-RZGL111VD2M-abc123'), 'RZGL111VD2M');
  });

  test('serial contenant lui-meme des tirets', () => {
    assert.equal(usbSerialFromMdnsSerial('adb-A1-B2-C3-xyz789'), 'A1-B2-C3');
  });

  test('un serial USB ordinaire ne correspond pas', () => {
    assert.equal(usbSerialFromMdnsSerial('RZGL111VD2M'), undefined);
  });
});

describe('dedupeDevices', () => {
  // Sortie reellement observee apres une association sans fil : le meme telephone
  // apparait deux fois, une entree TCP et une entree mDNS.
  const REAL_DOUBLE = [
    'List of devices attached',
    '192.168.95.90:34509    device product:a17xx model:SM_A175F device:a17 transport_id:3',
    'adb-RZGL111VD2M-86k6NG._adb-tls-connect._tcp.\tdevice product:a17xx model:SM_A175F device:a17 transport_id:5',
    '',
  ].join('\n');

  test('regroupe les entrees TCP et mDNS d un meme appareil', () => {
    const devices = parseDevices(REAL_DOUBLE);
    assert.equal(devices.length, 2, 'adb en liste bien deux');
    assert.equal(dedupeDevices(devices).length, 1, 'mais il n y a qu un seul telephone');
  });

  test('conserve l entree TCP, celle sur laquelle adb disconnect agit', () => {
    const [device] = dedupeDevices(parseDevices(REAL_DOUBLE));
    assert.equal(device?.transport, 'tcp');
    assert.equal(device?.serial, '192.168.95.90:34509');
  });

  test('l ordre des entrees ne change pas le resultat', () => {
    const reversed = [
      'List of devices attached',
      'adb-RZGL111VD2M-86k6NG._adb-tls-connect._tcp.\tdevice product:a17xx model:SM_A175F device:a17 transport_id:5',
      '192.168.95.90:34509    device product:a17xx model:SM_A175F device:a17 transport_id:3',
      '',
    ].join('\n');
    const [device] = dedupeDevices(parseDevices(reversed));
    assert.equal(device?.transport, 'tcp');
  });

  test('les appareils USB ne sont JAMAIS fusionnes : leur serial est fiable', () => {
    const devices = parseDevices(
      [
        'List of devices attached',
        'SERIAL_A\tdevice product:a17xx model:SM_A175F device:a17 transport_id:1',
        'SERIAL_B\tdevice product:a17xx model:SM_A175F device:a17 transport_id:2',
        '',
      ].join('\n'),
    );
    assert.equal(dedupeDevices(devices).length, 2);
  });

  test('deux appareils sans fil distincts restent distincts', () => {
    const devices = parseDevices(
      [
        'List of devices attached',
        '192.168.1.10:5555    device product:a17xx model:SM_A175F device:a17 transport_id:1',
        '192.168.1.11:5555    device product:redfin model:Pixel_5 device:redfin transport_id:2',
        '',
      ].join('\n'),
    );
    assert.equal(dedupeDevices(devices).length, 2);
  });

  test('sans signature exploitable, on ne fusionne pas', () => {
    // Sortie courte `adb devices` : aucune propriete, donc aucun rapprochement possible.
    const devices = parseDevices(
      'List of devices attached\n192.168.1.10:5555\tdevice\n192.168.1.11:5555\tdevice\n',
    );
    assert.equal(dedupeDevices(devices).length, 2);
  });

  test('liste vide', () => {
    assert.deepEqual(dedupeDevices([]), []);
  });
});
