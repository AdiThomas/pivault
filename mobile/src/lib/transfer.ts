/**
 * Moving files between the phone and the server (native version).
 * The web build uses transfer.web.ts instead.
 */
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File as FsFile, Paths, UploadType } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { ApiError, withQuery } from './api';
import { getFreshSession } from './auth';
import type { Asset, UploadResult } from './types';

export type PickedFile = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
  /** The browser File object (web only). */
  webFile?: unknown;
};

export type UploadTarget = {
  folderId?: string | null;
  deviceId?: string | null;
  deviceAssetId?: string | null;
  takenAt?: number | null;
};

export async function pickFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    type: '*/*',
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType ?? undefined,
    size: asset.size ?? undefined,
  }));
}

export function uploadUrl(serverUrl: string, name: string, target: UploadTarget): string {
  return withQuery(`${serverUrl}/api/assets`, {
    filename: name,
    folder_id: target.folderId ?? undefined,
    device_id: target.deviceId ?? undefined,
    device_asset_id: target.deviceAssetId ?? undefined,
    taken_at: target.takenAt ?? undefined,
  });
}

/**
 * Upload one local file as the raw request body.
 * `background: true` hands the transfer to iOS, so it keeps going if the app is
 * suspended part-way through.
 */
export async function uploadFile(
  file: PickedFile,
  target: UploadTarget = {},
  options: {
    onProgress?: (fraction: number) => void;
    background?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<UploadResult> {
  const session = await getFreshSession();
  const mime = file.mimeType || 'application/octet-stream';
  const result = await new FsFile(file.uri).upload(uploadUrl(session.serverUrl, file.name, target), {
    httpMethod: 'POST',
    uploadType: UploadType.BINARY_CONTENT,
    mimeType: mime,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': mime,
    },
    sessionType: options.background ? 'background' : 'foreground',
    signal: options.signal,
    onProgress: options.onProgress
      ? ({ bytesSent, totalBytes }) =>
          options.onProgress?.(totalBytes > 0 ? Math.min(1, bytesSent / totalBytes) : 0)
      : undefined,
  });
  if (result.status !== 200 && result.status !== 201) {
    let detail = `Upload failed (${result.status})`;
    try {
      const body = JSON.parse(result.body);
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      // Not JSON.
    }
    throw new ApiError(result.status, detail);
  }
  return JSON.parse(result.body) as UploadResult;
}

function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'download';
}

/** Download an asset's original into the app cache and return the local file. */
export async function downloadToCache(asset: Asset): Promise<FsFile> {
  const session = await getFreshSession();
  const dir = new Directory(Paths.cache, 'pivault-downloads', asset.id);
  dir.create({ intermediates: true, idempotent: true });
  const destination = new FsFile(dir, safeName(asset.original_name));
  return FsFile.downloadFileAsync(
    `${session.serverUrl}/api/assets/${asset.id}/original`,
    destination,
    { headers: { Authorization: `Bearer ${session.accessToken}` }, idempotent: true },
  );
}

/** Save a photo or video from the server into the phone's camera roll. */
export async function saveToDevice(asset: Asset): Promise<string> {
  if (asset.kind === 'file') {
    await shareAsset(asset);
    return 'Opened the share sheet';
  }
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    throw new Error('PiVault needs permission to add photos. Allow it in Settings.');
  }
  const file = await downloadToCache(asset);
  await MediaLibrary.Asset.create(file.uri);
  return 'Saved to your camera roll';
}

/** Open the iOS share sheet (AirDrop, Save to Files, Messages...). */
export async function shareAsset(asset: Asset): Promise<void> {
  const file = await downloadToCache(asset);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  await Sharing.shareAsync(file.uri, { mimeType: asset.mime, dialogTitle: asset.original_name });
}

/** Open a non-media file. On iOS the share sheet includes Quick Look and Save to Files. */
export async function openFile(asset: Asset): Promise<void> {
  await shareAsset(asset);
}

export const canSaveToCameraRoll = true;
