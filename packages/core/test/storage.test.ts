import test, { describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const previousHome = process.env['TIALAO_ADB_HOME'];
let dir = '';

// Le module lit TIALAO_ADB_HOME à chaque appel : on peut donc l'importer normalement.
const storage = await import('../src/storage.ts');

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tadb-test-'));
  process.env['TIALAO_ADB_HOME'] = dir;
});

after(async () => {
  if (previousHome === undefined) delete process.env['TIALAO_ADB_HOME'];
  else process.env['TIALAO_ADB_HOME'] = previousHome;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(storage.storagePath(), { force: true });
  await rm(`${storage.storagePath()}.bak`, { force: true });
});

describe('storage', () => {
  test('fichier absent : historique vide, sans lever', async () => {
    assert.deepEqual(await storage.loadHistory(), []);
  });

  test('JSON corrompu : historique vide et fichier mis de côté en .bak', async () => {
    await mkdir(storage.storageDir(), { recursive: true });
    await writeFile(storage.storagePath(), '{ ceci n est pas du json', 'utf8');

    assert.deepEqual(await storage.loadHistory(), []);
    // Le fichier illisible est conservé plutôt que perdu.
    const backup = await readFile(`${storage.storagePath()}.bak`, 'utf8');
    assert.match(backup, /ceci n est pas/);
  });

  test('upsert puis relecture', async () => {
    await storage.upsertDevice({
      id: 'RZGL111VD2M',
      label: 'SM-A175F',
      usbSerial: 'RZGL111VD2M',
      lastSeenIp: '192.168.95.90',
    });

    const devices = await storage.loadHistory();
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.label, 'SM-A175F');
    assert.ok(devices[0]?.pairedAt);
  });

  test('le fichier écrit porte un schemaVersion', async () => {
    await storage.upsertDevice({ id: 'x', label: 'X' });
    const raw = JSON.parse(await readFile(storage.storagePath(), 'utf8')) as {
      schemaVersion: number;
    };
    assert.equal(raw.schemaVersion, 1);
  });

  test('dédoublonnage sur le serial USB, même si l’IP a changé', async () => {
    await storage.upsertDevice({
      id: '192.168.95.90',
      label: 'SM-A175F',
      usbSerial: 'RZGL111VD2M',
      lastSeenIp: '192.168.95.90',
    });
    await storage.upsertDevice({
      id: '10.0.0.42',
      label: 'SM-A175F (bureau)',
      usbSerial: 'RZGL111VD2M',
      lastSeenIp: '10.0.0.42',
    });

    const devices = await storage.loadHistory();
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.lastSeenIp, '10.0.0.42');
    assert.equal(devices[0]?.label, 'SM-A175F (bureau)');
  });

  test('pairedAt est conservé lors des mises à jour', async () => {
    const first = await storage.upsertDevice({ id: 'a', label: 'A', usbSerial: 'S1' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await storage.upsertDevice({ id: 'a', label: 'A bis', usbSerial: 'S1' });
    assert.equal(second.pairedAt, first.pairedAt);
  });

  test('touchConnected met à jour l’adresse vue en dernier', async () => {
    await storage.upsertDevice({ id: 'RZGL111VD2M', label: 'A', usbSerial: 'RZGL111VD2M' });
    await storage.touchConnected('RZGL111VD2M', '192.168.95.90', 37123);

    const [device] = await storage.loadHistory();
    assert.equal(device?.lastSeenIp, '192.168.95.90');
    assert.equal(device?.lastPort, 37123);
    assert.ok(device?.lastConnectedAt);
  });

  test('removeDevice', async () => {
    await storage.upsertDevice({ id: 'a', label: 'A' });
    await storage.upsertDevice({ id: 'b', label: 'B' });
    await storage.removeDevice('a');

    const devices = await storage.loadHistory();
    assert.deepEqual(devices.map((d) => d.id), ['b']);
  });

  test('aucun fichier temporaire ne subsiste après écriture', async () => {
    await storage.upsertDevice({ id: 'a', label: 'A' });
    await assert.rejects(readFile(`${storage.storagePath()}.tmp`, 'utf8'));
  });
});
