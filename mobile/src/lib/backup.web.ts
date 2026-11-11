/** Web version of backup.ts. Browsers cannot read a camera roll, so backup is a no-op. */
import { initialBackupState, useBackup, type BackupReason } from './backupState';

export const backupSupported = false;

export async function runBackup(_reason: BackupReason): Promise<void> {
  useBackup.setState({
    ...initialBackupState,
    phase: 'unsupported',
    message: 'Automatic camera-roll backup runs in the PiVault iPhone app.',
  });
}

export function stopBackup(): void {}

export async function resetBackup(): Promise<void> {
  useBackup.setState({ ...initialBackupState });
}

export async function reviewPhotoAccess(): Promise<void> {}
