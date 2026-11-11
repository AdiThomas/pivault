/** Web version of backgroundTask.ts: there is no background execution in a browser tab. */

export const BACKUP_TASK = 'pivault-backup';

export type BackgroundSupport = 'available' | 'restricted' | 'unavailable';

export async function backgroundSupport(): Promise<BackgroundSupport> {
  return 'unavailable';
}

export async function setBackgroundBackup(_enabled: boolean): Promise<boolean> {
  return false;
}
