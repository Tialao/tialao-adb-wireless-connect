import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { pairWithCode, startQrPairing } from '../src/pairing.ts';
import type { PairingEvent } from '../src/pairing.ts';
import {
  MDNS_OK,
  USB_LINE,
  devicesOutput,
  makeFakeAdb,
  mdnsOutput,
  wirelessLine,
} from './fake-adb.ts';

const HOST = '192.168.95.90';
const PAIR_PORT = 41234;
const CONNECT_PORT = 37123;
const GUID = 'adb-RZGL111VD2M-abc123';

/** Options serrées : les tests ne doivent pas attendre des secondes. */
const FAST = { pollIntervalMs: 5, timeoutMs: 1_500, includeSvg: false as const };

function collect(session: { on(l: (e: PairingEvent) => void): unknown }): PairingEvent[] {
  const events: PairingEvent[] = [];
  session.on((e) => events.push(e));
  return events;
}

function states(events: PairingEvent[]): string[] {
  return events.filter((e) => e.type === 'state').map((e) => e.to);
}

describe('startQrPairing — chemin nominal', () => {
  test('scan, association puis connexion explicite', async () => {
    const serviceNameRef = { value: '' };
    let connected = false;
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === '--version') return { stdout: 'Android Debug Bridge version 1.0.41\n' };
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') {
        // L'appareil sans fil n'apparaît qu'APRÈS notre `adb connect` : ici, pas
        // d'auto-connect, c'est bien la piste A qui doit gagner.
        return {
          stdout: connected
            ? devicesOutput(USB_LINE, wirelessLine(HOST, CONNECT_PORT))
            : devicesOutput(USB_LINE),
        };
      }
      if (cmd === 'mdns services') {
        return {
          stdout: mdnsOutput(
            `${serviceNameRef.value}\t_adb-tls-pairing._tcp\t${HOST}:${String(PAIR_PORT)}`,
            `${GUID}\t_adb-tls-connect._tcp\t${HOST}:${String(CONNECT_PORT)}`,
          ),
        };
      }
      if (cmd.startsWith('pair ')) {
        return {
          stdout: `Successfully paired to ${HOST}:${String(PAIR_PORT)} [guid=${GUID}]\n`,
        };
      }
      if (cmd.startsWith('connect ')) {
        connected = true;
        return { stdout: `connected to ${HOST}:${String(CONNECT_PORT)}\n` };
      }
      return {};
    });

    const session = startQrPairing(fake.adb, FAST);
    const events = collect(session);
    serviceNameRef.value = session.credentials?.serviceName ?? '';

    const result = await session.done;

    assert.equal(result.ok, true);
    assert.equal(result.endState, 'connected');
    assert.equal(result.usbSerial, 'RZGL111VD2M');
    assert.deepEqual(states(events), [
      'checking-mdns',
      'awaiting-scan',
      'pairing',
      'awaiting-connect',
      'connecting',
      'connected',
    ]);
  });

  test('le QR est prêt avant toute attente, avec le bon payload', async () => {
    const fake = makeFakeAdb((args) => {
      if (args.join(' ') === 'mdns check') return { stdout: MDNS_OK };
      return { stdout: '' };
    });
    const session = startQrPairing(fake.adb, { ...FAST, timeoutMs: 60 });
    const events = collect(session);
    await session.done;

    const qr = events.find((e) => e.type === 'qr-ready');
    assert.ok(qr);
    assert.match(qr.payload, /^WIFI:T:ADB;S:studio-[A-Za-z0-9]{6};P:[A-Za-z0-9]{12};;$/);
  });
});

describe("startQrPairing — course avec l'auto-connect d'adb", () => {
  test("quand adb s'est connecté seul, `adb connect` n'est JAMAIS lancé", async () => {
    let paired = false;
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') {
        // Après l'association, l'appareil apparaît de lui-même : c'est
        // ADB_MDNS_AUTO_CONNECT=adb-tls-connect qui a agi.
        return {
          stdout: paired
            ? devicesOutput(USB_LINE, wirelessLine(HOST, CONNECT_PORT))
            : devicesOutput(USB_LINE),
        };
      }
      if (cmd === 'mdns services') {
        return {
          stdout: mdnsOutput(
            `${String(serviceNameRef.value)}\t_adb-tls-pairing._tcp\t${HOST}:${String(PAIR_PORT)}`,
          ),
        };
      }
      if (cmd.startsWith('pair ')) {
        paired = true;
        return { stdout: `Successfully paired to ${HOST}:${String(PAIR_PORT)} [guid=${GUID}]\n` };
      }
      return {};
    });

    const serviceNameRef = { value: '' };
    const session = startQrPairing(fake.adb, FAST);
    serviceNameRef.value = session.credentials?.serviceName ?? '';
    const events = collect(session);

    const result = await session.done;

    assert.equal(result.ok, true);
    assert.equal(result.viaAutoConnect, true);
    // L'assertion centrale : aucun `adb connect` n'a été lancé.
    assert.equal(fake.callsMatching('connect').length, 0);
    // On n'est jamais passé par l'état `connecting`, qui n'existe que pour la piste A.
    assert.equal(states(events).includes('connecting'), false);

    const connected = events.find((e) => e.type === 'connected');
    assert.equal(connected?.viaAutoConnect, true);
  });

  test('"already connected" est traité comme un succès', async () => {
    const serviceNameRef = { value: '' };
    let paired = false;
    let connectCalls = 0;
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') {
        return {
          stdout:
            paired && connectCalls > 0
              ? devicesOutput(USB_LINE, wirelessLine(HOST, CONNECT_PORT))
              : devicesOutput(USB_LINE),
        };
      }
      if (cmd === 'mdns services') {
        const lines = [
          `${serviceNameRef.value}\t_adb-tls-pairing._tcp\t${HOST}:${String(PAIR_PORT)}`,
        ];
        if (paired) lines.push(`${GUID}\t_adb-tls-connect._tcp\t${HOST}:${String(CONNECT_PORT)}`);
        return { stdout: mdnsOutput(...lines) };
      }
      if (cmd.startsWith('pair ')) {
        paired = true;
        return { stdout: `Successfully paired to ${HOST}:${String(PAIR_PORT)} [guid=${GUID}]\n` };
      }
      if (cmd.startsWith('connect ')) {
        connectCalls += 1;
        return { stdout: `already connected to ${HOST}:${String(CONNECT_PORT)}\n` };
      }
      return {};
    });

    const session = startQrPairing(fake.adb, FAST);
    serviceNameRef.value = session.credentials?.serviceName ?? '';
    const result = await session.done;

    assert.equal(result.ok, true);
    assert.equal(result.endState, 'connected');
  });
});

describe('startQrPairing — échecs', () => {
  test('mot de passe erroné : échec immédiat, sans réessai', async () => {
    const serviceNameRef = { value: '' };
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') return { stdout: devicesOutput(USB_LINE) };
      if (cmd === 'mdns services') {
        return {
          stdout: mdnsOutput(
            `${serviceNameRef.value}\t_adb-tls-pairing._tcp\t${HOST}:${String(PAIR_PORT)}`,
          ),
        };
      }
      // Code de sortie 0 malgré l'échec : le piège que le parser doit attraper.
      if (cmd.startsWith('pair ')) return { stdout: 'Failed: Wrong password\n', code: 0 };
      return {};
    });

    const session = startQrPairing(fake.adb, FAST);
    serviceNameRef.value = session.credentials?.serviceName ?? '';
    const result = await session.done;

    assert.equal(result.ok, false);
    assert.equal(result.endState, 'failed');
    assert.equal(result.error?.code, 'PAIR_WRONG_PASSWORD');
    // Une seule tentative : réessayer un mauvais mot de passe n'a aucun sens.
    assert.equal(fake.callsMatching('pair').length, 1);
  });

  test('échec transitoire : jusqu’à 3 tentatives', async () => {
    const serviceNameRef = { value: '' };
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') return { stdout: devicesOutput(USB_LINE) };
      if (cmd === 'mdns services') {
        return {
          stdout: mdnsOutput(
            `${serviceNameRef.value}\t_adb-tls-pairing._tcp\t${HOST}:${String(PAIR_PORT)}`,
          ),
        };
      }
      if (cmd.startsWith('pair ')) return { stdout: 'Failed: Unable to start pairing client.\n' };
      return {};
    });

    const session = startQrPairing(fake.adb, FAST);
    serviceNameRef.value = session.credentials?.serviceName ?? '';
    const result = await session.done;

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'PAIR_FAILED');
    assert.equal(fake.callsMatching('pair').length, 3);
  });

  test('personne ne scanne : timeout, avec un message qui le dit', async () => {
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') return { stdout: devicesOutput(USB_LINE) };
      if (cmd === 'mdns services') return { stdout: mdnsOutput() };
      return {};
    });

    const session = startQrPairing(fake.adb, { ...FAST, timeoutMs: 120 });
    const result = await session.done;

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'MDNS_NO_SERVICES');
    assert.equal(fake.callsMatching('pair').length, 0);
  });

  test('backend mDNS indisponible : erreur explicite', async () => {
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stderr: 'ERROR: mdns daemon unavailable\n', code: 1 };
      return {};
    });

    const session = startQrPairing(fake.adb, { ...FAST, allowServerRestart: false });
    const result = await session.done;

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'MDNS_UNAVAILABLE');
  });

  test('cancel() pendant l’attente : état cancelled', async () => {
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') return { stdout: devicesOutput(USB_LINE) };
      if (cmd === 'mdns services') return { stdout: mdnsOutput() };
      return {};
    });

    const session = startQrPairing(fake.adb, { ...FAST, timeoutMs: 10_000 });
    setTimeout(() => session.cancel(), 40);
    const result = await session.done;

    assert.equal(result.ok, false);
    assert.equal(result.endState, 'cancelled');
  });
});

describe('repli manuel', () => {
  test('submitManualAddress court-circuite la découverte mDNS', async () => {
    let paired = false;
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'mdns check') return { stdout: MDNS_OK };
      if (cmd === 'devices -l') {
        return {
          stdout: paired
            ? devicesOutput(USB_LINE, wirelessLine(HOST, CONNECT_PORT))
            : devicesOutput(USB_LINE),
        };
      }
      // Le mDNS ne découvrira jamais rien : c'est tout l'intérêt du repli.
      if (cmd === 'mdns services') return { stdout: mdnsOutput() };
      if (cmd.startsWith('pair ')) {
        paired = true;
        return { stdout: `Successfully paired to ${HOST}:${String(PAIR_PORT)} [guid=${GUID}]\n` };
      }
      return {};
    });

    const session = startQrPairing(fake.adb, { ...FAST, timeoutMs: 10_000 });
    setTimeout(() => session.submitManualAddress({ host: HOST, port: PAIR_PORT }), 30);
    const result = await session.done;

    assert.equal(result.ok, true);
    assert.equal(fake.callsMatching('pair').length, 1);
  });
});

describe('pairWithCode', () => {
  test('associe puis connecte, sans passer par le QR', async () => {
    let paired = false;
    const fake = makeFakeAdb((args) => {
      const cmd = args.join(' ');
      if (cmd === 'devices -l') {
        return {
          stdout: paired
            ? devicesOutput(USB_LINE, wirelessLine(HOST, CONNECT_PORT))
            : devicesOutput(USB_LINE),
        };
      }
      if (cmd === 'mdns services') return { stdout: mdnsOutput() };
      if (cmd.startsWith('pair ')) {
        paired = true;
        return { stdout: `Successfully paired to ${HOST}:${String(PAIR_PORT)} [guid=${GUID}]\n` };
      }
      return {};
    });

    const session = pairWithCode(fake.adb, { host: HOST, port: PAIR_PORT }, '123456', {
      pollIntervalMs: 5,
      timeoutMs: 1_500,
    });
    const result = await session.done;

    assert.equal(result.ok, true);
    assert.equal(result.endState, 'connected');
    // Le code doit être transmis tel quel à adb.
    assert.deepEqual(fake.callsMatching('pair')[0], ['pair', `${HOST}:${String(PAIR_PORT)}`, '123456']);
    // Aucune découverte mDNS n'est requise pour ce flux.
    assert.equal(fake.callsMatching('mdns check').length, 0);
  });

  test('code mal formé : rejeté avant tout appel à adb', async () => {
    const fake = makeFakeAdb(() => ({}));
    const session = pairWithCode(fake.adb, { host: HOST, port: PAIR_PORT }, '12ab');
    const result = await session.done;

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'INVALID_ARGUMENT');
    assert.equal(fake.callsMatching('pair').length, 0);
  });
});
