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
  | { type: 'connected'; label: string; detail: string }
  /** Adresse d'association découverte en mDNS, pour préremplir le formulaire. */
  | { type: 'detected-address'; address: string | null }
  /** Bascule l'affichage entre le flux QR et le flux par code. */
  | { type: 'mode'; mode: 'qr' | 'code' }
  /** Appareils connus d'adb, pour la fenêtre « Appareils ». */
  | {
      type: 'devices';
      devices: Array<{
        name: string;
        serial: string;
        state: string;
        transport: string;
        /** Absent pour un appareil USB ou connu seulement en mDNS. */
        address?: { host: string; port: number };
      }>;
    };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'cancel' }
  | { type: 'retry' }
  /** Adresse saisie dans le panneau, en repli de la découverte mDNS. */
  | { type: 'manual'; host: string; port: number }
  /** Le webview désigne QUOI copier ; l'hôte fournit la valeur depuis ses propres
   *  identifiants. Transporter la valeur laisserait un script injecté placer un
   *  texte arbitraire dans le presse-papiers. */
  | { type: 'copy'; target: 'service' | 'password' }
  /** Exécute une commande de l'extension depuis la barre d'actions du panneau. */
  | { type: 'command'; command: string }
  /** Lance l'association par code à 6 chiffres, saisie dans le panneau. */
  | { type: 'pair-code'; host: string; port: number; code: string }
  /** Demande la découverte mDNS de l'adresse d'association du téléphone. */
  | { type: 'detect-address' }
  /** Demande la liste des appareils connus d'adb. */
  | { type: 'list-devices' }
  /** Déconnecte un appareil précis, ou tous si `address` est absent. */
  | { type: 'disconnect'; address?: { host: string; port: number }; label: string };
