import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findConnectServiceForHost,
  findPairingService,
  parseMdnsCheck,
  parseMdnsServices,
} from '../src/parse.ts';
import { CONNECT_SERVICE_TYPE, PAIRING_SERVICE_TYPE } from '../src/types.ts';
import { fixture } from './helpers.ts';

describe('parseMdnsServices', () => {
  test('en-tete seul : aucun service', () => {
    assert.deepEqual(parseMdnsServices(fixture('mdns-empty.txt')), []);
  });

  test('chaine vide : aucun service', () => {
    assert.deepEqual(parseMdnsServices(''), []);
  });

  test('service de pairing separe par TABULATION', () => {
    const [s] = parseMdnsServices(fixture('mdns-pairing-tab.txt'));
    assert.ok(s);
    assert.equal(s.instance, 'studio-Ab3xK9');
    assert.equal(s.type, PAIRING_SERVICE_TYPE);
    assert.equal(s.host, '192.168.95.90');
    assert.equal(s.port, 41234);
    assert.equal(s.raw.includes('studio-Ab3xK9'), true);
  });

  test('DEFENSIF : espaces multiples et point final sur le type', () => {
    // Ce n'est PAS le format observe (cf. le test de sortie reelle plus bas, qui
    // utilise une tabulation et aucun point final) : c'est une tolerance volontaire,
    // pour ne pas casser sur une autre version d'adb.
    const services = parseMdnsServices(fixture('mdns-mixed-spaces.txt'));
    assert.equal(services.length, 2);
    // Le point final de `._tcp.` est normalise.
    assert.equal(services[0]?.type, PAIRING_SERVICE_TYPE);
    assert.equal(services[1]?.type, CONNECT_SERVICE_TYPE);
    assert.equal(services[1]?.port, 37123);
  });

  test('IPv6 : les crochets sont retires, la zone %iface est conservee', () => {
    const [s] = parseMdnsServices(fixture('mdns-ipv6.txt'));
    assert.ok(s);
    assert.equal(s.host, 'fe80::1c2d:3e4f:5a6b:7c8d%wlan0');
    assert.equal(s.port, 37123);
  });

  test('SORTIE REELLE capturee sur adb 35.0.2 / SM-A175F (Android 16)', () => {
    // Capture le 2026-08-28, Debogage sans fil actif, octets bruts conserves.
    // Elle tranche deux points qui n'etaient jusque-la que supposes :
    //  - le separateur est une TABULATION UNIQUE, pas des espaces multiples ;
    //  - le type n'a PAS de point final (`_adb-tls-connect._tcp`, pas `._tcp.`).
    const [s] = parseMdnsServices(fixture('mdns-connect-real.crlf.txt'));
    assert.ok(s);
    assert.equal(s.instance, 'adb-RZGL111VD2M-86k6NG');
    assert.equal(s.type, CONNECT_SERVICE_TYPE);
    assert.equal(s.host, '192.168.95.90');
    assert.equal(s.port, 34509);
    // Le port du telephone est aleatoire et change a chaque redemarrage : ce qui
    // est verifie ici, c'est qu'il est bien converti en nombre, sans le retour
    // chariot de fin de ligne.
    assert.equal(typeof s.port, 'number');
  });

  test('lignes malformees ignorees sans lever, les valides sont conservees', () => {
    const services = parseMdnsServices(fixture('mdns-malformed.txt'));
    assert.equal(services.length, 1);
    assert.equal(services[0]?.type, CONNECT_SERVICE_TYPE);
    assert.equal(services[0]?.port, 37123);
  });

  test('CRLF : resultat identique a la variante LF', () => {
    assert.deepEqual(
      parseMdnsServices(fixture('mdns-mixed-spaces.crlf.txt')),
      parseMdnsServices(fixture('mdns-mixed-spaces.txt')),
    );
  });

  test('port hors bornes : ligne rejetee', () => {
    const services = parseMdnsServices(
      'List of discovered mdns services\nstudio-Ab3xK9\t_adb-tls-pairing._tcp\t192.168.95.90:99999\n',
    );
    assert.deepEqual(services, []);
  });

  test('le bruit du daemon est filtre', () => {
    const services = parseMdnsServices(
      '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of discovered mdns services\nstudio-Ab3xK9\t_adb-tls-pairing._tcp\t192.168.95.90:41234\n',
    );
    assert.equal(services.length, 1);
  });
});

describe('findPairingService / findConnectServiceForHost', () => {
  const services = parseMdnsServices(fixture('mdns-mixed-spaces.txt'));

  test('trouve le service de pairing par nom exact', () => {
    assert.equal(findPairingService(services, 'studio-Ab3xK9')?.port, 41234);
  });

  test('la comparaison du nom est sensible a la casse', () => {
    // Le nom vient du QR qu'on a genere : une correspondance approximative
    // risquerait d'associer un appareil tiers appairant au meme moment.
    assert.equal(findPairingService(services, 'studio-ab3xk9'), undefined);
  });

  test('un nom inconnu ne correspond a rien', () => {
    assert.equal(findPairingService(services, 'studio-ZZZZZZ'), undefined);
  });

  test('trouve le service de connexion par IP', () => {
    assert.equal(findConnectServiceForHost(services, '192.168.95.90')?.port, 37123);
  });

  test('une autre IP ne correspond pas', () => {
    assert.equal(findConnectServiceForHost(services, '192.168.95.91'), undefined);
  });
});

describe('parseMdnsCheck', () => {
  test('sortie Openscreen reellement observee (adb 35.0.2)', () => {
    const check = parseMdnsCheck(fixture('mdns-check-openscreen.txt'), '', 0);
    assert.equal(check.available, true);
    assert.equal(check.backend, 'openscreen');
    assert.equal(check.version, '0.0.0');
  });

  test('backend Bonjour', () => {
    const check = parseMdnsCheck(fixture('mdns-check-bonjour.txt'), '', 0);
    assert.equal(check.available, true);
    assert.equal(check.backend, 'bonjour');
  });

  test('daemon indisponible', () => {
    const check = parseMdnsCheck('', fixture('mdns-check-unavailable.txt'), 1);
    assert.equal(check.available, false);
    assert.equal(check.backend, 'unknown');
  });

  test('sortie vide : indisponible, sans lever', () => {
    const check = parseMdnsCheck('', '', null);
    assert.equal(check.available, false);
    assert.equal(check.backend, 'unknown');
  });
});
