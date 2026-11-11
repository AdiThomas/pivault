/** Trash: deleted items wait here for 30 days. */
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Thumb } from '@/components/Thumb';
import { Button, EmptyState, IconButton, Loading, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { actionSheet, confirm, errorText, toast } from '@/lib/dialogs';
import { flatten, invalidateAssets, useAssetList } from '@/lib/queries';
import { font, maxContentWidth, spacing } from '@/lib/theme';
import type { Asset } from '@/lib/types';

const COLUMNS = 4;

export default function TrashScreen() {
  const session = useAuth((state) => state.session);
  const { width } = useWindowDimensions();
  const list = useAssetList('trash');
  const assets = useMemo(() => flatten(list.data?.pages), [list.data]);
  const [busy, setBusy] = useState(false);
  const gridWidth = Math.min(width, maxContentWidth);
  const cell = Math.floor(gridWidth / COLUMNS);

  const act = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await action();
      toast(done);
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
      invalidateAssets();
    }
  };

  const onPress = async (asset: Asset) => {
    const choice = await actionSheet({
      title: asset.original_name,
      options: [
        ...(asset.kind !== 'file' ? [{ key: 'view', label: 'View', icon: 'eye-outline' }] : []),
        { key: 'restore', label: 'Restore', icon: 'arrow-undo-outline' },
        { key: 'delete', label: 'Delete forever', icon: 'trash-outline', destructive: true },
      ],
    });
    if (choice === 'view') {
      router.push({ pathname: '/viewer/[id]', params: { id: asset.id, source: 'trash' } });
    }
    if (choice === 'restore') await act(async () => void (await api.restoreAsset(asset.id)), 'Restored');
    if (choice === 'delete') {
      const ok = await confirm({
        title: 'Delete forever?',
        message: 'This removes the file from your Pi. It cannot be undone.',
        confirmLabel: 'Delete forever',
        destructive: true,
      });
      if (ok) await act(() => api.deleteAsset(asset.id, true), 'Deleted');
    }
  };

  const emptyTrash = async () => {
    const ok = await confirm({
      title: `Delete ${assets.length} item${assets.length === 1 ? '' : 's'} forever?`,
      message: 'This removes them from your Pi. It cannot be undone.',
      confirmLabel: 'Empty trash',
      destructive: true,
    });
    if (!ok) return;
    await act(async () => {
      // Ask the server page by page, so items that are not on screen go too.
      for (;;) {
        const page = await api.listAssets({ trashed: true, limit: 200 });
        if (!page.items.length) break;
        for (const asset of page.items) await api.deleteAsset(asset.id, true);
      }
    }, 'Trash emptied');
  };

  return (
    <Screen
      title="Trash"
      right={
        <>
          {assets.length ? (
            <Button
              label="Empty"
              variant="danger"
              onPress={emptyTrash}
              disabled={busy}
              testID="trash-empty"
              style={styles.emptyButton}
            />
          ) : null}
          <IconButton
            icon="close"
            label="Close trash"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
            testID="trash-close"
          />
        </>
      }>
      {list.isPending ? (
        <Loading />
      ) : !assets.length ? (
        <EmptyState
          icon="trash-outline"
          title="Trash is empty"
          message="Deleted items stay here for 30 days before they are removed for good."
        />
      ) : (
        <>
          <Text style={[font.small, styles.note]}>
            Items are deleted for good 30 days after they are moved here. Tap one to restore it.
          </Text>
          <FlatList
            testID="trash-list"
            data={assets}
            numColumns={COLUMNS}
            keyExtractor={(asset) => asset.id}
            onEndReached={() => {
              if (list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
            }}
            renderItem={({ item }) => (
              <View>
                <Thumb asset={item} size={cell} session={session} onPress={onPress} />
              </View>
            )}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, lineHeight: 19 },
  emptyButton: { minHeight: 36, paddingHorizontal: spacing.md },
});
