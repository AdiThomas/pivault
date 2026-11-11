/** User preferences, saved on the device. */
import { create } from 'zustand';

import * as storage from './storage';

const KEY = 'pivault.settings';

export type Settings = {
  /** Only upload on Wi-Fi (video backups can be many gigabytes). */
  wifiOnly: boolean;
  includeVideos: boolean;
  /** Start a backup pass whenever the app is opened. */
  backupOnOpen: boolean;
  /** Ask iOS to wake the app now and then to look for new photos. */
  backgroundBackup: boolean;
  gridColumns: number;
  /** This phone's id on the server, set the first time a backup runs. */
  deviceId: string | null;
  lastBackupAt: number | null;
};

export const defaultSettings: Settings = {
  wifiOnly: true,
  includeVideos: true,
  backupOnOpen: true,
  backgroundBackup: false,
  gridColumns: 4,
  deviceId: null,
  lastBackupAt: null,
};

type SettingsState = Settings & { loaded: boolean };

export const useSettings = create<SettingsState>(() => ({ ...defaultSettings, loaded: false }));

export async function hydrateSettings(): Promise<Settings> {
  const state = useSettings.getState();
  if (state.loaded) return state;
  let saved: Partial<Settings> = {};
  const raw = await storage.getItem(KEY);
  if (raw) {
    try {
      saved = JSON.parse(raw) as Partial<Settings>;
    } catch {
      saved = {};
    }
  }
  useSettings.setState({ ...defaultSettings, ...saved, loaded: true });
  return useSettings.getState();
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  useSettings.setState(patch);
  const { loaded: _loaded, ...settings } = useSettings.getState();
  await storage.setItem(KEY, JSON.stringify(settings));
}

/** Forget everything tied to an account (called on logout). */
export async function resetAccountSettings(): Promise<void> {
  await updateSettings({ deviceId: null, lastBackupAt: null });
}
