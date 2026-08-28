import type { PairingCredentials, PairingState } from 'tialao-adb-wireless';

/** Protocole typé entre l'extension et le webview. Une union par sens. */

export type StepId = 'scan' | 'pairing' | 'connecting' | 'connected';

export type HostToWebview =
  | {
      type: 'qr';
      svg: string;
      payload: string;
      credentials: PairingCredentials;
      timeoutMs: number;
    }
  | { type: 'state'; state: PairingState; step: StepId; label: string }
  | { type: 'countdown'; remainingMs: number; totalMs: number }
  | { type: 'notice'; level: 'info' | 'warn'; message: string; hint?: string }
  | { type: 'failed'; message: string; hint?: string; canRetry: boolean }
  | { type: 'connected'; label: string; detail: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'manual' }
  | { type: 'copy'; value: string; what: string };
