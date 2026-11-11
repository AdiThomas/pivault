/** Photos tab: the timeline, newest first, grouped by month. */
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { Thumb } from '@/components/Thumb';
import { UploadBanner } from '@/components/UploadBanner';
import { Button, EmptyState, IconButton, Loading, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { confirm, errorText, toast } from '@/lib/dialogs';
import { monthKey, monthLabel } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import { flatten, invalidateAssets, useAssetList } from '@/lib/queries';
import { updateSettings, useSettings } from '@/lib/settings';
import { colors, font, spacing } from '@/lib/theme';
import type { Asset } from '@/lib/types';
import { pickAndUpload } from '@/lib/uploader';

type ListRow =
  | { type: 'header'; key: string; title: string; count: number }
  | { type: 'row'; key: string; assets: Asset[] };

const COLUMN_CHOICES = [3, 4, 5, 6];
const MAX_GRID_WIDTH = 1100;

/** Month headers followed by rows of `columns` thumbnails. */
function buildRows(assets: Asset[], columns: number): ListRow[] {
  const rows: ListRow[] = [];
  let month = '';
  let header: Extract<ListRow, { type: 'header' }> | null = null;
  let current: Asset[] = [];
  const flush = () => {
    if (current.length) rows.push({ type: 'row', key: `r-${current[0].id}`, assets: current });
    current = [];
  };
  for (const asset of assets) {
    const key = monthKey(asset.taken_at);
    if (key !== month) {
      flush();
      month = key;
      header = { type: 'header', key: `h-${key}`, title: monthLabel(asset.taken_at), count: 0 };
      rows.push(header);
    }
    if (header) header.count += 1;
    current.push(asset);
    if (current.length === columns) flush();
  }
  flush();
  return rows;
}

export default function PhotosScreen() {
  const session = useAuth((state) => state.session);
  const preferred = useSettings((state) => state.gridColumns);
  const { width } = useWindowDimensions();
  const list = useAssetList('timeline');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const assets = useMemo(() => flatten(list.data?.pages), [list.data]);
  // Wider screens (tablets, the web) get more columns than the phone setting.
  const columns = preferred + (width > 900 ? 3 : width > 600 ? 1 : 0);
  const gridWidth = Math.min(width, MAX_GRID_WIDTH);
  const cell = Math.floor(gridWidth / columns);
  const rows = useMemo(() => buildRows(assets, columns), [assets, columns]);
  const selecting = selected.size > 0;

  const toggle = useCallback((asset: Asset) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.add(asset.id);
      return next;
    });
  }, []);

  const onPress = useCallback(
    (asset: Asset) => {
      if (selecting) {
        haptics.tap();
        toggle(asset);
      } else {
        router.push({ pathname: '/viewer/[id]', params: { id: asset.id, source: 'timeline' } });
      }
    },
    [selecting, toggle],
  );

  const onLongPress = useCallback(
    (asset: Asset) => {
      haptics.tap();
      toggle(asset);
    },
    [toggle],
  );

  const cycleColumns = () => {
    haptics.tap();
    const index = COLUMN_CHOICES.indexOf(preferred);
    updateSettings({ gridColumns: COLUMN_CHOICES[(index + 1) % COLUMN_CHOICES.length] });
  };

  const deleteSelected = async () => {
    const count = selected.size;
    const ok = await confirm({
      title: `Move ${count} item${count === 1 ? '' : 's'} to the trash?`,
      message: 'They stay in the trash for 30 days, then are deleted for good.',
      confirmLabel: 'Move to trash',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await Promise.all([...selected].map((id) => api.deleteAsset(id)));
      setSelected(new Set());
      haptics.success();
      toast(`${count} moved to the trash`);
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
      invalidateAssets();
    }
  };

  const renderItem = useCallback(
    ({ item }: { item: ListRow }) => {
      if (item.type === 'header') {
        return (
          <View style={styles.monthHeader}>
            <Text style={font.heading} accessibilityRole="header">
              {item.title}
            </Text>
          </View>
        );
      }
      return (
        <View style={styles.row}>
          {item.assets.map((asset) => (
            <Thumb
              key={asset.id}
              asset={asset}
              size={cell}
              session={session}
              selecting={selecting}
              selected={selected.has(asset.id)}
              onPress={onPress}
              onLongPress={onLongPress}
            />
          ))}
        </View>
      );
    },
    [cell, session, selecting, selected, onPress, onLongPress],
  );

  const headerRight = selecting ? (
    <>
      <Text style={font.small} testID="selection-count">
        {selected.size} selected
      </Text>
      <IconButton
        icon="trash-outline"
        label="Move selected to trash"
        color={colors.danger}
        onPress={deleteSelected}
        disabled={busy}
        testID="selection-delete"
      />
      <IconButton
        icon="close"
        label="Cancel selection"
        onPress={() => setSelected(new Set())}
        testID="selection-cancel"
      />
    </>
  ) : (
    <>
      <IconButton
        icon="grid-outline"
        label={`Change grid size, now ${preferred} columns`}
        onPress={cycleColumns}
        testID="grid-columns"
      />
      <IconButton
        icon="add-circle-outline"
        label="Upload photos or videos"
        onPress={() => pickAndUpload(null)}
        size={26}
        testID="photos-upload"
      />
    </>
  );

  let body;
  if (list.isPending) {
    body = <Loading />;
  } else if (list.isError && !assets.length) {
    body = (
      <EmptyState
        icon="cloud-offline-outline"
        title="Can't reach your server"
        message={errorText(list.error)}
        action={<Button label="Try again" onPress={() => list.refetch()} variant="secondary" />}
      />
    );
  } else if (!assets.length) {
    body = (
      <EmptyState
        icon="images-outline"
        title="No photos yet"
        message="Turn on backup to copy your camera roll here, or upload a few photos to get started."
        action={
          <Button label="Upload photos" icon="add" onPress={() => pickAndUpload(null)} testID="empty-upload" />
        }
      />
    );
  } else {
    body = (
      <View style={[styles.grid, { width: gridWidth }]} testID="photo-grid">
        <FlashList
          data={rows}
          renderItem={renderItem}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          extraData={selected}
          onEndReached={() => {
            if (list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
          }}
          onEndReachedThreshold={2}
          refreshing={list.isRefetching && !list.isFetchingNextPage}
          onRefresh={() => list.refetch()}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
        />
      </View>
    );
  }

  return (
    <Screen title="Photos" right={headerRight} wide>
      <UploadBanner />
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flex: 1, alignSelf: 'center' },
  row: { flexDirection: 'row' },
  monthHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bg,
  },
  listContent: { paddingBottom: spacing.xxl },
});
