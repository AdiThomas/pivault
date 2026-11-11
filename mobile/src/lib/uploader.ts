/** Manual uploads (the "+" buttons): pick files, send them one by one, show progress. */
import { create } from 'zustand';

import { errorText, toast } from './dialogs';
import * as haptics from './haptics';
import { invalidateAssets } from './queries';
import { pickFiles, uploadFile } from './transfer';

type UploaderState = {
  active: boolean;
  done: number;
  total: number;
  currentName: string | null;
  /** 0..1 for the current file. */
  fraction: number;
};

export const useUploader = create<UploaderState>(() => ({
  active: false,
  done: 0,
  total: 0,
  currentName: null,
  fraction: 0,
}));

/**
 * Pick files and upload them.
 * folderId: a folder id or "root" to put them in Files; null for photos that only
 * belong in the timeline.
 */
export async function pickAndUpload(folderId: string | null = null): Promise<void> {
  if (useUploader.getState().active) return;
  let files;
  try {
    files = await pickFiles();
  } catch (error) {
    toast(errorText(error), 'error');
    return;
  }
  if (!files.length) return;

  useUploader.setState({ active: true, done: 0, total: files.length, fraction: 0 });
  let added = 0;
  let duplicates = 0;
  let failed = 0;
  let lastError = '';
  for (const file of files) {
    useUploader.setState({ currentName: file.name, fraction: 0 });
    try {
      const result = await uploadFile(
        file,
        { folderId },
        { onProgress: (fraction) => useUploader.setState({ fraction }) },
      );
      if (result.duplicate) duplicates += 1;
      else added += 1;
    } catch (error) {
      failed += 1;
      lastError = errorText(error);
    }
    useUploader.setState({ done: useUploader.getState().done + 1 });
  }
  useUploader.setState({ active: false, currentName: null, fraction: 0 });
  invalidateAssets();

  if (failed) {
    toast(`${failed} of ${files.length} failed: ${lastError}`, 'error');
    return;
  }
  haptics.success();
  const parts: string[] = [];
  if (added) parts.push(`${added} uploaded`);
  if (duplicates) parts.push(`${duplicates} already in your vault`);
  toast(parts.join(', '));
}
