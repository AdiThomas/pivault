/** Shapes returned by the PiVault API (see backend/app/schemas.py). */

export type AssetKind = 'photo' | 'video' | 'file';
export type AssetStatus = 'processing' | 'ready' | 'failed';

export type Asset = {
  id: string;
  kind: AssetKind;
  origin: 'backup' | 'upload';
  /** Listed in the Files tab. */
  in_files: boolean;
  original_name: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  taken_at: string;
  created_at: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  lat: number | null;
  lon: number | null;
  status: AssetStatus;
  folder_id: string | null;
  device_id: string | null;
  deleted_at: string | null;
};

export type AssetPage = { items: Asset[]; next_cursor: string | null };

export type UploadResult = { asset: Asset; duplicate: boolean };

export type Folder = {
  id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
};

export type Stats = {
  photos: number;
  videos: number;
  files: number;
  trashed: number;
  processing: number;
  failed: number;
  bytes_used: number;
  disk_total: number;
  disk_free: number;
};

export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
};

export type User = { id: string; email: string; created_at: string };

export type Device = { id: string; name: string; platform: string | null };

export type Health = { status: string; version: string; checks: Record<string, string> };
