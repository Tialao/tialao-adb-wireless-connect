import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { watchMdns } from '../src/mdns.ts';
import type { MdnsWatchEvent } from '../src/mdns.ts';
import { MDNS_OK, makeFakeAdb, mdnsOutput } from './fake-adb.ts';

const LINE = 'adb-RZGL111VD2M-86k6NG\t_adb-tls-connect._tcp\t192.168.95.90:34509';

function collect(watcher: { on(l: (e: MdnsWatchEvent) => void): unknown }): MdnsWatchEvent[] {
  const events: MdnsWatchEvent[] = [];
  watcher.on((e) => events.push(e));
  return events;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('watchMdns', () => {
  test('RÉGRESSION : le timer de sondage ne doit PAS être unref()', async () => {
    // Un timer unref() n'empêche pas Node de quitter. Le flux d'association passe
    // l'essentiel de son temps à attendre entre deux sondages : avec unref(), le
    // process `tadb pair-qr` sortait de lui-même (code 13) juste après le premier
    // sondage, sans jamais laisser le temps de scanner le QR.
    const fake = makeFakeAdb(() => ({ stdout: mdnsOutput() }));
    const watcher = watchMdns(fake.adb, { intervalMs: 20, timeoutMs: 5_000 });

    await wait(60);

    const timers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
    assert.ok(timers.length > 0, 'aucun timer actif : la boucle ne serait pas maintenue en vie');

    watcher.stop();
  });

  test('sonde en boucle et remonte les services découverts', async () => {
    const fake = makeFakeAdb(() => ({ stdout: mdnsOutput(LINE) }));
    const watcher = watchMdns(fake.adb, { intervalMs: 10, timeoutMs: 5_000 });
    const events = collect(watcher);

    await wait(80);
    watcher.stop();

    const ticks = events.filter((e) => e.type === 'tick');
    assert.ok(ticks.length >= 2, `attendu au moins 2 sondages, obtenu ${String(ticks.length)}`);
    assert.equal(ticks[0]?.services[0]?.port, 34509);
  });

  test('émet `added` une seule fois pour un service stable', async () => {
    const fake = makeFakeAdb(() => ({ stdout: mdnsOutput(LINE) }));
    const watcher = watchMdns(fake.adb, { intervalMs: 10, timeoutMs: 5_000 });
    const events = collect(watcher);

    await wait(80);
    watcher.stop();

    assert.equal(events.filter((e) => e.type === 'added').length, 1);
  });

  test('émet `removed` quand le service disparaît', async () => {
    let calls = 0;
    const fake = makeFakeAdb(() => {
      calls += 1;
      // Le service de connexion disparaît souvent dès qu'adb l'a consommé.
      return { stdout: calls <= 2 ? mdnsOutput(LINE) : mdnsOutput() };
    });
    const watcher = watchMdns(fake.adb, { intervalMs: 10, timeoutMs: 5_000 });
    const events = collect(watcher);

    await wait(120);
    watcher.stop();

    assert.equal(events.filter((e) => e.type === 'added').length, 1);
    assert.equal(events.filter((e) => e.type === 'removed').length, 1);
  });

  test('émet `timeout` puis s’arrête', async () => {
    const fake = makeFakeAdb(() => ({ stdout: mdnsOutput() }));
    const watcher = watchMdns(fake.adb, { intervalMs: 10, timeoutMs: 40 });
    const events = collect(watcher);

    await wait(150);

    assert.equal(events.some((e) => e.type === 'timeout'), true);
    assert.equal(watcher.stopped, true);
  });

  test('stop() interrompt les sondages', async () => {
    const fake = makeFakeAdb(() => ({ stdout: mdnsOutput() }));
    const watcher = watchMdns(fake.adb, { intervalMs: 10, timeoutMs: 5_000 });

    await wait(50);
    const before = fake.calls.length;
    watcher.stop();
    await wait(60);

    assert.equal(fake.calls.length, before, 'des sondages ont continué après stop()');
  });

  test('un AbortSignal arrête le watcher', async () => {
    const fake = makeFakeAdb(() => ({ stdout: mdnsOutput() }));
    const controller = new AbortController();
    const watcher = watchMdns(fake.adb, {
      intervalMs: 10,
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    await wait(30);
    controller.abort();
    await wait(40);

    assert.equal(watcher.stopped, true);
  });

  test('signale un mDNS muet plutôt que d’attendre en silence', async () => {
    // C'est le cas Windows typique (pare-feu, réseau public) : adb ne renvoie
    // jamais d'erreur, juste une liste vide, indéfiniment.
    const fake = makeFakeAdb(() => ({ stdout: mdnsOutput() }));
    const watcher = watchMdns(fake.adb, { intervalMs: 2, timeoutMs: 5_000 });
    const events = collect(watcher);

    await wait(250);
    watcher.stop();

    const silent = events.find((e) => e.type === 'silent');
    assert.ok(silent, 'aucun événement `silent` après de nombreux sondages vides');
    assert.equal(silent.error.code, 'MDNS_NO_SERVICES');
    assert.ok(silent.error.hint);
    // Une seule fois : ce n'est pas une alarme répétée à chaque sondage.
    assert.equal(events.filter((e) => e.type === 'silent').length, 1);
  });

  test('un sondage en échec ne casse pas la boucle', async () => {
    let calls = 0;
    const fake = makeFakeAdb(() => {
      calls += 1;
      if (calls === 2) return { stderr: 'adb: erreur transitoire\n', code: 1 };
      return { stdout: mdnsOutput(LINE) };
    });
    const watcher = watchMdns(fake.adb, { intervalMs: 10, timeoutMs: 5_000 });
    const events = collect(watcher);

    await wait(100);
    watcher.stop();

    assert.ok(events.filter((e) => e.type === 'tick').length >= 3);
  });
});

describe('ensureMdnsAvailable', () => {
  test('backend disponible : ne redémarre pas le serveur adb', async () => {
    const { ensureMdnsAvailable } = await import('../src/mdns.ts');
    const fake = makeFakeAdb((args) =>
      args.join(' ') === 'mdns check' ? { stdout: MDNS_OK } : {},
    );

    const check = await ensureMdnsAvailable(fake.adb);

    assert.equal(check.available, true);
    // Redémarrer le serveur couperait les sessions adb des autres outils.
    assert.equal(fake.callsMatching('kill-server').length, 0);
  });

  test('backend indisponible : redémarre avec ADB_MDNS_OPENSCREEN', async () => {
    const { ensureMdnsAvailable } = await import('../src/mdns.ts');
    let checks = 0;
    const fake = makeFakeAdb((args) => {
      if (args.join(' ') === 'mdns check') {
        checks += 1;
        return checks === 1 ? { stderr: 'ERROR: mdns daemon unavailable\n', code: 1 } : { stdout: MDNS_OK };
      }
      return {};
    });

    const check = await ensureMdnsAvailable(fake.adb);

    assert.equal(check.available, true);
    assert.equal(fake.callsMatching('kill-server').length, 1);
    assert.equal(fake.callsMatching('start-server').length >= 1, true);
  });

  test('allowRestart:false : aucun redémarrage même si indisponible', async () => {
    const { ensureMdnsAvailable } = await import('../src/mdns.ts');
    const fake = makeFakeAdb(() => ({ stderr: 'ERROR: mdns daemon unavailable\n', code: 1 }));

    const check = await ensureMdnsAvailable(fake.adb, { allowRestart: false });

    assert.equal(check.available, false);
    assert.equal(fake.callsMatching('kill-server').length, 0);
  });
});
