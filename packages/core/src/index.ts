/**
 * Surface publique de `tialao-adb-wireless`.
 *
 * REGLE D'ARCHITECTURE : toute la logique vit ici, dans `core`. Les integrations
 * (extension VS Code, futurs portages) ne doivent contenir que de l'interface et
 * consommer ce module. Aucun `console.*` ici : le coeur ne parle que par valeurs de
 * retour et par evenements.
 */

export { Adb, defaultRunner, redactSecrets, resolveAdbPath, sleep } from './adb.ts';
export type { AdbLocation, AdbLogEntry, AdbOptions, ExecOptions, ExecRunner } from './adb.ts';

export { Emitter } from './emitter.ts';
export type { Listener, Unsubscribe } from './emitter.ts';

export { EXIT_CODES, TadbError, exitCodeFor, toTadbError } from './errors.ts';
export type { TadbErrorCode, TadbErrorOptions } from './errors.ts';

export {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  ensureMdnsAvailable,
  watchMdns,
} from './mdns.ts';
export type { MdnsWatchEvent, MdnsWatchOptions, MdnsWatcher } from './mdns.ts';

export {
  dedupeDevices,
  findConnectServiceForHost,
  findPairingService,
  formatHostPort,
  parseAdbVersion,
  parseConnectOutput,
  parseDeviceIp,
  parseDevices,
  parseHostPort,
  parseMdnsCheck,
  parseMdnsServices,
  parsePairOutput,
  stripAdbNoise,
  toLines,
  usbSerialFromMdnsSerial,
} from './parse.ts';

export {
  KEYCODE,
  avcCodecFromConfig,
  SCRCPY_SERVER_SHA256,
  SCRCPY_SERVER_VERSION,
  bundledServerPath,
  generateScid,
  startMirror,
} from './scrcpy.ts';
export type {
  KeyAction,
  ScrcpyEvent,
  ScrcpyOptions,
  ScrcpySession,
  ScrcpyVideoFrame,
  TouchAction,
} from './scrcpy.ts';

export { pairWithCode, startQrPairing } from './pairing.ts';
export type {
  CodePairingOptions,
  PairingEvent,
  PairingResult,
  PairingSession,
  PairingState,
  QrPairingOptions,
} from './pairing.ts';

export {
  buildQrPayload,
  generatePairingCredentials,
  parseQrPayload,
  pickTerminalMode,
  renderQrSvg,
  renderQrSvgFallback,
  renderQrSvgSafe,
  renderQrTerminal,
} from './qr.ts';
export type { QrSvgOptions, RandomIntFn, TerminalQrMode } from './qr.ts';

export {
  clearHistory,
  loadHistory,
  removeDevice,
  storageDir,
  storagePath,
  touchConnected,
  upsertDevice,
} from './storage.ts';
export type { DeviceUpsert } from './storage.ts';

export { CONNECT_SERVICE_TYPE, PAIRING_SERVICE_TYPE } from './types.ts';
export type {
  AdbDevice,
  AdbVersion,
  ConnectResult,
  DeviceHistoryFile,
  DeviceState,
  DeviceTransport,
  HostPort,
  MdnsCheck,
  MdnsService,
  PairFailureReason,
  PairResult,
  PairingCredentials,
  RawExec,
  StoredDevice,
} from './types.ts';
