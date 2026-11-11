/** Backup progress, shared between the backup engine and the Backup tab. */
import { create } from 'zustand';

export type BackupPhase =
  | 'idle'
  | 'scanning'
  | 'checking'
  | 'uploading'
  | 'done'
  | 'error'
  | 'needsPermission'
  | 'waitingForWifi'
  | 'unsupported';

export type BackupState = {
  phase: BackupPhase;
  /** Photos (and videos, when included) found in the camera roll. */
  total: number;
  /** How many of those are safely on the server. */
  backedUp: number;
  /** Uploaded during the current run. */
  uploadedThisRun: number;
  failedThisRun: number;
  /** Left to upload in the current run. */
  remaining: number;
  currentName: string | null;
  /** 0..1 for the file being uploaded right now. */
  currentProgress: number;
  message: string | null;
  /** True when iOS only granted access to selected photos. */
  limitedAccess: boolean;
};

export const initialBackupState: BackupState = {
  phase: 'idle',
  total: 0,
  backedUp: 0,
  uploadedThisRun: 0,
  failedThisRun: 0,
  remaining: 0,
  currentName: null,
  currentProgress: 0,
  message: null,
  limitedAccess: false,
};

export const useBackup = create<BackupState>(() => ({ ...initialBackupState }));

export function isRunning(phase: BackupPhase): boolean {
  return phase === 'scanning' || phase === 'checking' || phase === 'uploading';
}

export type BackupReason = 'manual' | 'open' | 'background';
