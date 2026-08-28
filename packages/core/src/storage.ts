/**
 * Historique local des appareils associés, partagé entre le CLI et l'extension.
 *
 * Fichier unique plutôt que le `globalState` de VS Code : un appareil associé depuis le
 * terminal doit apparaître dans l'extension, et réciproquement.
 *
 * RÈGLE : le port n'est jamais considéré comme fiable. Le téléphone en tire un nouveau
 * à chaque redémarrage ; `lastPort` n'est gardé qu'à titre indicatif et la reconnexion
 * passe toujours par une redécouverte mDNS.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { TadbError } from './errors.ts';
import { sleep } from './adb.ts';
import type { DeviceHistoryFile, StoredDevice } from './types.ts';

const SCHEMA_VERSION = 1;

/** Dossier de données. `TIALAO_ADB_HOME` permet de le déplacer (tests, dossier en lecture seule). */
export function storageDir(): string {
  const override = process.env['TIALAO_ADB_HOME']?.trim();
  return override && override.length > 0 ? override : join(homedir(), '.tialao-adb-wireless');
}

export function storagePath(): string {
  return join(storageDir(), 'devices.json');
}

/**
 * Charge l'historique. Ne lève JAMAIS : un historique illisible est un désagrément,
 * pas une raison d'empêcher une association.
 */
export async function loadHistory(): Promise<StoredDevice[]> {
  const file = storagePath();
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  try {
    const parsed = JSON.parse(text) as Partial<DeviceHistoryFile>;
    if (!parsed || !Array.isArray(parsed.devices)) return [];
    return parsed.devices.filter((d): d is StoredDevice => typeof d?.id === 'string');
  } catch {
    // Fichier corrompu : on le met de côté plutôt que de le perdre silencieusement.
    try {
      await rename(file, `${file}.bak`);
    } catch {
      /* rien à faire de plus */
    }
    return [];
  }
}

async function saveHistory(devices: StoredDevice[]): Promise<void> {
  const file = storagePath();
  const payload: DeviceHistoryFile = { schemaVersion: SCHEMA_VERSION, devices };
  const temporary = `${file}.tmp`;

  try {
    // Le fichier n'a rien de secret, mais il cartographie le réseau et le matériel :
    // inutile de l'offrir aux autres comptes de la machine.
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });

    // Écriture atomique. Le rename peut échouer temporairement quand le dossier
    // utilisateur est synchronisé par OneDrive, d'où les tentatives successives.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
        await sleep(80 * (attempt + 1));
      }
    }
    throw lastError;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new TadbError('STORAGE_ERROR', `Impossible d'écrire ${file}.`, { cause: error });
  }
}

function sameDevice(a: StoredDevice, b: Pick<StoredDevice, 'id' | 'usbSerial'>): boolean {
  // Le serial USB est le seul identifiant réellement stable : l'IP change de réseau
  // en réseau, et le port change à chaque redémarrage du téléphone.
  if (a.usbSerial && b.usbSerial) return a.usbSerial === b.usbSerial;
  return a.id === b.id;
}

export type DeviceUpsert = Omit<StoredDevice, 'pairedAt'> & { pairedAt?: string };

/** Ajoute ou met à jour un appareil, en dédoublonnant sur le serial USB. */
export async function upsertDevice(entry: DeviceUpsert): Promise<StoredDevice> {
  const devices = await loadHistory();
  const existing = devices.find((d) => sameDevice(d, entry));
  const now = new Date().toISOString();

  const merged: StoredDevice = {
    ...existing,
    ...entry,
    pairedAt: existing?.pairedAt ?? entry.pairedAt ?? now,
  };

  const next = existing
    ? devices.map((d) => (sameDevice(d, entry) ? merged : d))
    : [merged, ...devices];

  await saveHistory(next);
  return merged;
}

export async function touchConnected(id: string, host: string, port: number): Promise<void> {
  const devices = await loadHistory();
  const next = devices.map((d) =>
    d.id === id || d.usbSerial === id
      ? { ...d, lastSeenIp: host, lastPort: port, lastConnectedAt: new Date().toISOString() }
      : d,
  );
  await saveHistory(next);
}

export async function removeDevice(id: string): Promise<void> {
  const devices = await loadHistory();
  await saveHistory(devices.filter((d) => d.id !== id && d.usbSerial !== id));
}

export async function clearHistory(): Promise<void> {
  await saveHistory([]);
}
