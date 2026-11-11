/** Typed client for the PiVault API. */
import { Platform } from 'react-native';

import { getFreshSession, refreshSession, useAuth, type Session } from './auth';
import type {
  Asset,
  AssetPage,
  Device,
  Folder,
  Health,
  Stats,
  User,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(url: string, query?: Query): string {
  if (!query) return url;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (!parts.length) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${parts.join('&')}`;
}

async function errorMessage(resp: Response): Promise<string> {
  try {
    const body = await resp.json();
    if (typeof body?.detail === 'string') return body.detail;
    if (Array.isArray(body?.detail) && body.detail[0]?.msg) return String(body.detail[0].msg);
  } catch {
    // Not JSON.
  }
  return `Request failed (${resp.status})`;
}

async function request<T>(
  path: string,
  options: { method?: string; query?: Query; body?: unknown } = {},
): Promise<T> {
  const send = (session: Session) =>
    fetch(withQuery(`${session.serverUrl}${path}`, options.query), {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

  let resp: Response;
  try {
    resp = await send(await getFreshSession());
    if (resp.status === 401) {
      // The token may have been revoked early; try once more with a new one.
      resp = await send(await refreshSession());
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, error instanceof Error ? error.message : 'Network error');
  }
  if (!resp.ok) throw new ApiError(resp.status, await errorMessage(resp));
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export type ListParams = {
  kind?: string;
  folderId?: string;
  trashed?: boolean;
  q?: string;
  cursor?: string | null;
  limit?: number;
};

export const api = {
  async health(serverUrl: string): Promise<Health> {
    const resp = await fetch(`${serverUrl}/api/health`);
    if (!resp.ok && resp.status !== 503) throw new ApiError(resp.status, 'Not a PiVault server');
    return (await resp.json()) as Health;
  },

  me: () => request<User>('/api/me'),
  stats: () => request<Stats>('/api/stats'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/api/me/password', {
      method: 'POST',
      body: { current_password: currentPassword, new_password: newPassword },
    }),

  listAssets: (params: ListParams = {}) =>
    request<AssetPage>('/api/assets', {
      query: {
        kind: params.kind,
        folder_id: params.folderId,
        trashed: params.trashed || undefined,
        q: params.q,
        cursor: params.cursor ?? undefined,
        limit: params.limit ?? 120,
      },
    }),

  getAsset: (id: string) => request<Asset>(`/api/assets/${id}`),

  patchAsset: (id: string, body: { original_name?: string; folder_id?: string | null }) =>
    request<Asset>(`/api/assets/${id}`, { method: 'PATCH', body }),

  deleteAsset: (id: string, permanent = false) =>
    request<void>(`/api/assets/${id}`, {
      method: 'DELETE',
      query: { permanent: permanent || undefined },
    }),

  restoreAsset: (id: string) => request<Asset>(`/api/assets/${id}/restore`, { method: 'POST' }),

  check: (deviceId: string, deviceAssetIds: string[]) =>
    request<{ missing: string[] }>('/api/assets/check', {
      method: 'POST',
      body: { device_id: deviceId, device_asset_ids: deviceAssetIds },
    }),

  registerDevice: (name: string, platform: string) =>
    request<Device>('/api/devices', { method: 'POST', body: { name, platform } }),

  listFolders: (parentId: string) =>
    request<Folder[]>('/api/folders', { query: { parent_id: parentId } }),

  allFolders: () => request<Folder[]>('/api/folders'),

  createFolder: (name: string, parentId: string | null) =>
    request<Folder>('/api/folders', { method: 'POST', body: { name, parent_id: parentId } }),

  patchFolder: (id: string, body: { name?: string; parent_id?: string | null }) =>
    request<Folder>(`/api/folders/${id}`, { method: 'PATCH', body }),

  deleteFolder: (id: string, recursive = false) =>
    request<void>(`/api/folders/${id}`, {
      method: 'DELETE',
      query: { recursive: recursive || undefined },
    }),
};

// -- media URLs ---------------------------------------------------------------

export type MediaSource = { uri: string; headers?: Record<string, string> };

/**
 * Where to load an image or video from, with credentials attached.
 * Native apps send the token as a header (so the URL, and the image cache key, stays
 * stable). Browsers cannot add headers to <img> or <video>, so the web build puts the
 * short-lived token in the query string.
 */
export function mediaSource(session: Session | null, path: string, query?: Query): MediaSource {
  if (!session) return { uri: '' };
  const base = withQuery(`${session.serverUrl}${path}`, query);
  if (Platform.OS === 'web') {
    return { uri: withQuery(base, { access_token: session.accessToken }) };
  }
  return { uri: base, headers: { Authorization: `Bearer ${session.accessToken}` } };
}

export function thumbSource(session: Session | null, assetId: string, size: 'thumb' | 'preview') {
  return mediaSource(session, `/api/assets/${assetId}/thumbnail`, { size });
}

export function originalSource(session: Session | null, assetId: string, download = false) {
  return mediaSource(session, `/api/assets/${assetId}/original`, {
    download: download || undefined,
  });
}

/** For code outside React (uploads, downloads). */
export function currentSession(): Session | null {
  return useAuth.getState().session;
}
