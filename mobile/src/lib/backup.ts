/**
 * Camera-roll backup (native version). The web build uses backup.web.ts.
 *
 * One pass:
 *   1. list the camera roll (ids and dates only, which is fast)
 *   2. drop everything the local ledger already knows is backed up
 *   3. ask the server which of the rest it is missing
 *   4. upload those, two at a time, as iOS background transfers
 *   5. record each success in the ledger so it is never checked again
 */
import * as Device from 'expo-device';
import * as MediaLibrary from 'expo-media-library';
import * as Network from 'expo-network';
import { Platform } from 'react-native';

import { api } from './api';
import { useAuth } from './auth';
import {
  initialBackupState,
  isRunning,
  useBackup,
  type BackupReason,
  type BackupState,
} from './backupState';
import * as ledger from './ledger';
import { hydrateSettings, updateSettings, useSettings } from './settings';
import { uploadFile } from './transfer';

const SCAN_PAGE = 500;
const CHECK_CHUNK = 500;
const CONCURRENCY = 2;

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  webp: 'image/webp',
  dng: 'image/x-adobe-dng',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
};

type Item = {
  id: string;
  filename: string | null;
  isVideo: boolean;
  /** Epoch milliseconds, or null when the library does not know. */
  takenAt: number | null;
};

let running: Promise<void> | null = null;
let abort: AbortController | null = null;

const set = (patch: Partial<BackupState>) => useBackup.setState(patch);

export const backupSupported = true;

function toMillis(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  // The media library reports seconds on some platforms and milliseconds on others.
  return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
}

function mimeFor(filename: string | null, isVideo: boolean): string {
  const ext = filename?.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? (isVideo ? 'video/quicktime' : 'image/jpeg');
}

async function hasPermission(ask: boolean): Promise<{ granted: boolean; limited: boolean }> {
  let permission = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
  if (!permission.granted && ask && permission.canAskAgain) {
    permission = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
  }
  return { granted: permission.granted, limited: permission.accessPrivileges === 'limited' };
}

async function onWifi(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isConnected === true && state.type === Network.NetworkStateType.WIFI;
  } catch {
    return false;
  }
}

async function ensureDevice(): Promise<string> {
  const existing = useSettings.getState().deviceId;
  if (existing) return existing;
  const name = Device.deviceName ?? Device.modelName ?? 'iPhone';
  const device = await api.registerDevice(name, Platform.OS);
  await updateSettings({ deviceId: device.id });
  return device.id;
}

async function scanLibrary(includeVideos: boolean, signal: AbortSignal): Promise<Item[]> {
  const items: Item[] = [];
  for (let offset = 0; ; offset += SCAN_PAGE) {
    if (signal.aborted) break;
    const page = await new MediaLibrary.Query()
      .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: false })
      .limit(SCAN_PAGE)
      .offset(offset)
      .exeForMetadata();
    for (const meta of page) {
      const isVideo = meta.mediaType === MediaLibrary.MediaType.VIDEO;
      const isImage = meta.mediaType === MediaLibrary.MediaType.IMAGE;
      if (!isImage && !(isVideo && includeVideos)) continue;
      items.push({
        id: meta.id,
        filename: meta.filename,
        isVideo,
        takenAt: toMillis(meta.creationTime),
      });
    }
    set({ total: items.length });
    if (page.length < SCAN_PAGE) break;
  }
  return items;
}

async function uploadOne(item: Item, deviceId: string, signal: AbortSignal): Promise<void> {
  const asset = new MediaLibrary.Asset(item.id);
  // Resolving the URI can take a while for photos that only live in iCloud.
  const uri = await asset.getUri();
  const name = item.filename ?? (await asset.getFilename()) ?? `${item.id.slice(0, 8)}.jpg`;
  set({ currentName: name, currentProgress: 0 });
  await uploadFile(
    { uri, name, mimeType: mimeFor(name, item.isVideo) },
    { deviceId, deviceAssetId: item.id, takenAt: item.takenAt },
    {
      background: true,
      signal,
      onProgress: (fraction) => {
        if (useBackup.getState().currentName === name) set({ currentProgress: fraction });
      },
    },
  );
}

async function run(reason: BackupReason): Promise<void> {
  const controller = new AbortController();
  abort = controller;
  const { signal } = controller;
  const settings = await hydrateSettings();

  if (useAuth.getState().status !== 'signedIn') return;

  const permission = await hasPermission(reason === 'manual');
  if (!permission.granted) {
    set({
      ...initialBackupState,
      phase: 'needsPermission',
      message: 'Allow access to your photos to start backing up.',
    });
    return;
  }

  if (settings.wifiOnly && !(await onWifi())) {
    set({
      phase: 'waitingForWifi',
      message: 'Waiting for Wi-Fi. Turn off "Wi-Fi only" to use mobile data.',
      limitedAccess: permission.limited,
    });
    return;
  }

  set({
    ...initialBackupState,
    phase: 'scanning',
    message: 'Looking through your camera roll...',
    limitedAccess: permission.limited,
  });

  const items = await scanLibrary(settings.includeVideos, signal);
  if (signal.aborted) return;

  const ids = items.map((item) => item.id);
  const known = await ledger.filterKnown(ids);
  const unknown = items.filter((item) => !known.has(item.id));
  set({ total: items.length, backedUp: known.size, phase: 'checking', message: 'Checking with your server...' });

  const deviceId = await ensureDevice();
  const missing = new Set<string>();
  for (let i = 0; i < unknown.length; i += CHECK_CHUNK) {
    if (signal.aborted) return;
    const chunk = unknown.slice(i, i + CHECK_CHUNK).map((item) => item.id);
    const result = await api.check(deviceId, chunk);
    for (const id of result.missing) missing.add(id);
    // Anything the server already has (for example after reinstalling the app).
    const present = chunk.filter((id) => !result.missing.includes(id));
    await ledger.markUploaded(present);
    set({ backedUp: useBackup.getState().backedUp + present.length });
  }

  // Oldest first, so an interrupted first backup resumes in a predictable order.
  const queue = unknown.filter((item) => missing.has(item.id)).reverse();
  set({ phase: 'uploading', remaining: queue.length, message: null });

  let cursor = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const item = queue[cursor];
      cursor += 1;
      if (!item) return;
      try {
        await uploadOne(item, deviceId, signal);
        await ledger.markUploaded([item.id]);
        const state = useBackup.getState();
        set({
          backedUp: state.backedUp + 1,
          uploadedThisRun: state.uploadedThisRun + 1,
          remaining: Math.max(0, state.remaining - 1),
        });
      } catch (error) {
        if (signal.aborted) return;
        const state = useBackup.getState();
        set({
          failedThisRun: state.failedThisRun + 1,
          remaining: Math.max(0, state.remaining - 1),
          message: error instanceof Error ? error.message : 'An upload failed',
        });
        if (useAuth.getState().status !== 'signedIn') return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (signal.aborted) return;

  await updateSettings({ lastBackupAt: Date.now() });
  const final = useBackup.getState();
  set({
    phase: 'done',
    currentName: null,
    currentProgress: 0,
    message:
      final.failedThisRun > 0
        ? `${final.failedThisRun} item${final.failedThisRun === 1 ? '' : 's'} could not be uploaded and will be retried next time.`
        : null,
  });
}

/**
 * Start a backup pass unless one is already running.
 * - 'manual': the user pressed the button; may show the permission prompt.
 * - 'open' / 'background': silent; never prompts.
 */
export function runBackup(reason: BackupReason): Promise<void> {
  if (running) return running;
  running = run(reason)
    .catch((error) => {
      set({
        phase: 'error',
        currentName: null,
        message: error instanceof Error ? error.message : 'Backup failed',
      });
    })
    .finally(() => {
      running = null;
      abort = null;
    });
  return running;
}

export function stopBackup(): void {
  abort?.abort();
  if (isRunning(useBackup.getState().phase)) {
    set({ phase: 'idle', currentName: null, currentProgress: 0, message: 'Backup paused.' });
  }
}

/** Forget what has been backed up (used on logout, or to force a full re-check). */
export async function resetBackup(): Promise<void> {
  stopBackup();
  await ledger.clearLedger();
  set({ ...initialBackupState });
}

/** Let the user widen a "selected photos only" grant. */
export async function reviewPhotoAccess(): Promise<void> {
  await MediaLibrary.presentPermissionsPicker();
}
