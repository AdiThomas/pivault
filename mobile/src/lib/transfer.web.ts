/** Web version of transfer.ts: browser file picker, XHR uploads, link downloads. */
import * as DocumentPicker from 'expo-document-picker';

import { ApiError, originalSource, withQuery } from './api';
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
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, type: '*/*' });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name,
    mimeType: asset.mimeType ?? undefined,
    size: asset.size ?? undefined,
    webFile: asset.file,
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
  const blob = file.webFile as Blob | undefined;
  if (!blob) throw new Error('No file selected');

  // No taken_at is sent from a browser: a file's modified time is usually when it was copied
  // or downloaded, so the server reads the real capture date from the photo itself.
  // XMLHttpRequest rather than fetch: it reports upload progress.
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl(session.serverUrl, file.name, target));
    xhr.setRequestHeader('Authorization', `Bearer ${session.accessToken}`);
    xhr.setRequestHeader('Content-Type', file.mimeType || blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status === 200 || xhr.status === 201) resolve(body as UploadResult);
      else reject(new ApiError(xhr.status, body?.detail ?? `Upload failed (${xhr.status})`));
    };
    options.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

function triggerDownload(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** In a browser, "save" means a normal download. */
export async function saveToDevice(asset: Asset): Promise<string> {
  const session = await getFreshSession();
  triggerDownload(originalSource(session, asset.id, true).uri, asset.original_name);
  return 'Download started';
}

export async function shareAsset(asset: Asset): Promise<void> {
  await saveToDevice(asset);
}

export async function openFile(asset: Asset): Promise<void> {
  const session = await getFreshSession();
  window.open(originalSource(session, asset.id).uri, '_blank', 'noopener');
}

export const canSaveToCameraRoll = false;
