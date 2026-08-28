/**
 * Génération des identifiants d'association et rendu du QR code.
 *
 * Le QR encode exactement la chaîne attendue par Android :
 *     WIFI:T:ADB;S:<serviceName>;P:<password>;;
 *
 * Contrainte de sécurité ET de correction : l'alphabet est strictement alphanumérique.
 * La grammaire `WIFI:` réserve `\ ; , : "` et impose de les échapper ; en n'en générant
 * jamais, on garantit qu'aucun échappement n'est nécessaire. L'invariant est vérifié par
 * un test de round-trip.
 *
 * Aucun accès réseau : tout est calculé localement.
 */

import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import type { PairingCredentials } from './types.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SERVICE_PREFIX = 'studio-';
const SERVICE_SUFFIX_LENGTH = 6;
const PASSWORD_LENGTH = 12;

/**
 * Niveau de correction d'erreur. Q (25 %) plutôt que M (15 %) : le rendu stylisé
 * (modules arrondis, marqueurs redessinés) coûte un peu de lisibilité optique, et
 * cette marge la compense.
 */
const ERROR_CORRECTION_LEVEL = 'Q';

export type RandomIntFn = (maxExclusive: number) => number;

const defaultRandom: RandomIntFn = (maxExclusive) => randomInt(maxExclusive);

function randomString(length: number, rng: RandomIntFn): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[rng(ALPHABET.length)];
  }
  return out;
}

/**
 * Génère un nom de service et un mot de passe à usage unique.
 * Convention Android Studio : `studio-` + 6 caractères, mot de passe de 12 caractères.
 */
export function generatePairingCredentials(rng: RandomIntFn = defaultRandom): PairingCredentials {
  return {
    serviceName: SERVICE_PREFIX + randomString(SERVICE_SUFFIX_LENGTH, rng),
    password: randomString(PASSWORD_LENGTH, rng),
  };
}

export function buildQrPayload(credentials: PairingCredentials): string {
  return `WIFI:T:ADB;S:${credentials.serviceName};P:${credentials.password};;`;
}

/** Relit un payload. Sert au round-trip de test et au diagnostic. */
export function parseQrPayload(payload: string): PairingCredentials | null {
  const m = /^WIFI:T:ADB;S:([^;]+);P:([^;]+);;$/.exec(payload.trim());
  if (!m) return null;
  return { serviceName: m[1] as string, password: m[2] as string };
}

/* --------------------------------------------------------------------------------------- */
/* Rendu SVG                                                                                 */
/* --------------------------------------------------------------------------------------- */

export interface QrSvgOptions {
  /** Marge en modules. 4 est le minimum de la spec ; en dessous, beaucoup de scanners échouent. */
  margin?: number;
  /** Couleur des modules. Volontairement figée en sombre : voir la note ci-dessous. */
  color?: string;
  background?: string;
  /** Rendu arrondi (défaut) ou carré strict. */
  rounded?: boolean;
}

interface QrMatrix {
  size: number;
  get(x: number, y: number): boolean;
}

function buildMatrix(payload: string): QrMatrix {
  const qr = QRCode.create(payload, { errorCorrectionLevel: ERROR_CORRECTION_LEVEL });
  const size = qr.modules.size;
  const data = qr.modules.data;
  return {
    size,
    get: (x, y) => x >= 0 && y >= 0 && x < size && y < size && data[y * size + x] === 1,
  };
}

/** Les trois marqueurs d'angle, redessinés à part pour un rendu net. */
function finderOrigins(size: number): Array<[number, number]> {
  return [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
}

function isInsideFinder(x: number, y: number, size: number): boolean {
  return finderOrigins(size).some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
}

/**
 * Rend le QR en SVG.
 *
 * NOTE IMPORTANTE — les couleurs ne sont PAS thémables, et c'est délibéré : un QR clair
 * sur fond sombre, ou dont les modules suivent le thème de l'éditeur, fait échouer une
 * bonne partie des scanners Android. Le QR reste sombre sur clair ; c'est la carte qui
 * l'entoure, côté webview, qui s'intègre au thème.
 */
export function renderQrSvg(payload: string, options: QrSvgOptions = {}): string {
  const margin = options.margin ?? 4;
  const color = options.color ?? '#0b0d12';
  const background = options.background ?? '#ffffff';
  const rounded = options.rounded ?? true;

  const matrix = buildMatrix(payload);
  const total = matrix.size + margin * 2;
  const parts: string[] = [];

  // Modules de données : cercles/carrés arrondis, marqueurs d'angle exclus.
  const radius = rounded ? 0.5 : 0;
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!matrix.get(x, y) || isInsideFinder(x, y, matrix.size)) continue;
      const cx = x + margin;
      const cy = y + margin;
      parts.push(
        `<rect x="${cx}" y="${cy}" width="1" height="1" rx="${radius}" ry="${radius}"/>`,
      );
    }
  }

  // Marqueurs d'angle : anneau 7x7 (trait de 1 module) + pupille 3x3.
  for (const [fx, fy] of finderOrigins(matrix.size)) {
    const x = fx + margin;
    const y = fy + margin;
    const outerR = rounded ? 2 : 0;
    const innerR = rounded ? 0.9 : 0;
    parts.push(
      `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="${outerR}" ry="${outerR}" fill="none" stroke="${color}" stroke-width="1"/>`,
      `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="${innerR}" ry="${innerR}"/>`,
    );
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="100%" height="100%" shape-rendering="geometricPrecision" role="img" aria-label="QR code d'association ADB">`,
    `<rect width="${total}" height="${total}" fill="${background}"/>`,
    `<g fill="${color}">${parts.join('')}</g>`,
    `</svg>`,
  ].join('');
}

/** Rendu SVG de secours, non stylisé, si la matrice ne peut pas être construite. */
export async function renderQrSvgFallback(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: ERROR_CORRECTION_LEVEL,
    margin: 4,
    color: { dark: '#0b0d12', light: '#ffffff' },
  });
}

/** Rend le QR en SVG, avec repli automatique sur le rendu non stylisé. */
export async function renderQrSvgSafe(payload: string, options: QrSvgOptions = {}): Promise<string> {
  try {
    return renderQrSvg(payload, options);
  } catch {
    return renderQrSvgFallback(payload);
  }
}

/* --------------------------------------------------------------------------------------- */
/* Rendu terminal                                                                            */
/* --------------------------------------------------------------------------------------- */

export type TerminalQrMode = 'auto' | 'compact' | 'wide';

/**
 * Choisit le rendu terminal. Les demi-blocs (`compact`) sont deux fois plus petits mais
 * s'affichent en « ? » dans conhost/cmd.exe en code page 850 ; on ne les utilise que sur
 * un terminal dont on sait qu'il gère l'UTF-8.
 */
export function pickTerminalMode(env: NodeJS.ProcessEnv = process.env): 'compact' | 'wide' {
  if (process.platform !== 'win32') return 'compact';
  if (env['WT_SESSION'] || env['TERM_PROGRAM'] || env['ConEmuANSI'] === 'ON') return 'compact';
  return 'wide';
}

export async function renderQrTerminal(
  payload: string,
  options: { mode?: TerminalQrMode; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const mode =
    options.mode && options.mode !== 'auto' ? options.mode : pickTerminalMode(options.env);
  return QRCode.toString(payload, {
    type: 'terminal',
    small: mode === 'compact',
    errorCorrectionLevel: ERROR_CORRECTION_LEVEL,
  });
}
