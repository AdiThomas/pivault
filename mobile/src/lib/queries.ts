/** Server-state cache (TanStack Query) and the asset list queries every screen shares. */
import { QueryClient, useInfiniteQuery } from '@tanstack/react-query';

import { api } from './api';
import type { Asset, AssetPage } from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

/**
 * Which list an asset is being viewed from. The viewer uses it to swipe through the
 * same items, in the same order, as the screen it was opened from.
 *   "timeline"      the Photos tab
 *   "folder:root"   the top level of Files
 *   "folder:<id>"   a folder
 *   "trash"         the Trash screen
 */
export type ListSource = string;

export const folderSource = (folderId: string | null): ListSource => `folder:${folderId ?? 'root'}`;

export function assetListKey(source: ListSource) {
  return ['assets', source] as const;
}

function listParams(source: ListSource) {
  if (source === 'trash') return { trashed: true };
  if (source.startsWith('folder:')) return { folderId: source.slice('folder:'.length) };
  return {};
}

export function useAssetList(source: ListSource, enabled = true) {
  return useInfiniteQuery({
    queryKey: assetListKey(source),
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.listAssets({ ...listParams(source), cursor: pageParam }),
    getNextPageParam: (last: AssetPage) => last.next_cursor,
    // Poll while the worker is still making thumbnails for something on screen.
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      const busy = pages.some((page) => page.items.some((item) => item.status === 'processing'));
      return busy ? 2500 : false;
    },
  });
}

export function flatten(pages: AssetPage[] | undefined): Asset[] {
  return pages ? pages.flatMap((page) => page.items) : [];
}

/** Call after anything that adds, removes or moves assets. */
export function invalidateAssets(): void {
  queryClient.invalidateQueries({ queryKey: ['assets'] });
  queryClient.invalidateQueries({ queryKey: ['stats'] });
}

export function invalidateFolders(): void {
  queryClient.invalidateQueries({ queryKey: ['folders'] });
}
