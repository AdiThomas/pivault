/**
 * Background backup (native version). iOS decides when this runs: usually when the
 * phone is charging and on Wi-Fi, often hours apart. Opening the app is what backs
 * photos up reliably; this is a bonus.
 *
 * Needs your own build of the app. It does not run inside Expo Go.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { hydrateAuth } from './auth';
import { runBackup } from './backup';
import { hydrateSettings } from './settings';

export const BACKUP_TASK = 'pivault-backup';

// Must be defined at module load (not inside a component) so iOS can find it when it
// launches the app in the background.
TaskManager.defineTask(BACKUP_TASK, async () => {
  try {
    const session = await hydrateAuth();
    const settings = await hydrateSettings();
    if (!session || !settings.backgroundBackup) {
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    await runBackup('background');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export type BackgroundSupport = 'available' | 'restricted' | 'unavailable';

export async function backgroundSupport(): Promise<BackgroundSupport> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    return status === BackgroundTask.BackgroundTaskStatus.Available ? 'available' : 'restricted';
  } catch {
    return 'unavailable';
  }
}

/** Turn background backup on or off. Returns false when the system refused. */
export async function setBackgroundBackup(enabled: boolean): Promise<boolean> {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(BACKUP_TASK);
    if (enabled && !registered) {
      // Minutes. iOS treats this as a hint, not a schedule.
      await BackgroundTask.registerTaskAsync(BACKUP_TASK, { minimumInterval: 60 });
    } else if (!enabled && registered) {
      await BackgroundTask.unregisterTaskAsync(BACKUP_TASK);
    }
    return true;
  } catch {
    return false;
  }
}
