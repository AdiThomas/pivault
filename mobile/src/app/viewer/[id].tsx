/** Full-screen viewer: swipe between items, pinch to zoom, play video, save, share, delete. */
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton, Loading } from '@/components/ui';
import { api, originalSource, thumbSource } from '@/lib/api';
import { useAuth, type Session } from '@/lib/auth';
import { confirm, errorText, toast } from '@/lib/dialogs';
import { formatBytes, formatDateTime, formatDuration } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import { flatten, invalidateAssets, useAssetList } from '@/lib/queries';
import { colors, font, spacing } from '@/lib/theme';
import { canSaveToCameraRoll, saveToDevice, shareAsset } from '@/lib/transfer';
import type { Asset } from '@/lib/types';

function isMedia(asset: Asset): boolean {
  return asset.kind === 'photo' || asset.kind === 'video';
}

export default function ViewerScreen() {
  const params = useLocalSearchParams<{ id: string; source?: string }>();
  const source = params.source ?? 'timeline';
  const session = useAuth((state) => state.session);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  // The same list the user came from, so swiping follows the order they saw.
  const list = useAssetList(source);
  // Fallback when the item is not in the loaded pages (for example a direct link).
  const single = useQuery({
    queryKey: ['asset', params.id],
    queryFn: () => api.getAsset(params.id),
  });

  // Items deleted or restored from here disappear at once, without waiting for a refetch.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());

  const items = useMemo(() => {
    const fromList = flatten(list.data?.pages)
      .filter(isMedia)
      .filter((asset) => !removed.has(asset.id));
    if (removed.has(params.id) || fromList.some((asset) => asset.id === params.id)) return fromList;
    return single.data && !removed.has(single.data.id) ? [single.data] : [];
  }, [list.data, single.data, params.id, removed]);

  const startIndex = Math.max(0, items.findIndex((asset) => asset.id === params.id));
  const [index, setIndex] = useState(startIndex);
  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<Asset>>(null);
  const current = items[Math.min(index, items.length - 1)];

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= items.length) return;
      listRef.current?.scrollToIndex({ index: next, animated: true });
      setIndex(next);
    },
    [items.length],
  );

  // Arrow keys and Escape in a browser.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') goTo(index + 1);
      else if (event.key === 'ArrowLeft') goTo(index - 1);
      else if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, index]);

  // Load more when swiping near the end of what is loaded.
  useEffect(() => {
    if (index >= items.length - 5 && list.hasNextPage && !list.isFetchingNextPage) {
      list.fetchNextPage();
    }
  }, [index, items.length, list]);

  // FlatList needs this callback to keep the same identity for its whole life.
  const onViewable = useCallback(
    ({ viewableItems }: { viewableItems: { index?: number | null }[] }) => {
      const first = viewableItems[0];
      if (first?.index != null) setIndex(first.index);
    },
    [],
  );

  const run = async (action: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true);
    try {
      const message = await action();
      if (message) toast(message);
      haptics.success();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    const trashed = current.deleted_at !== null;
    const ok = await confirm(
      trashed
        ? {
            title: 'Delete forever?',
            message: 'This removes the file from your Pi. It cannot be undone.',
            confirmLabel: 'Delete forever',
            destructive: true,
          }
        : {
            title: `Move this ${current.kind} to the trash?`,
            message: 'It stays in the trash for 30 days.',
            confirmLabel: 'Move to trash',
            destructive: true,
          },
    );
    if (!ok) return;
    await run(async () => {
      await api.deleteAsset(current.id, trashed);
      leave(current.id);
      return trashed ? 'Deleted' : 'Moved to the trash';
    });
  };

  const restore = () =>
    run(async () => {
      if (!current) return;
      await api.restoreAsset(current.id);
      leave(current.id);
      return 'Restored';
    });

  /** Drop an item from this viewer: the next one slides into its place. */
  const leave = (id: string) => {
    const wasLast = items.length <= 1;
    setRemoved((previous) => new Set(previous).add(id));
    setIndex((value) => Math.max(0, Math.min(value, items.length - 2)));
    invalidateAssets();
    if (wasLast) close();
  };

  if (!current) {
    return (
      <View style={styles.screen}>
        {single.isError ? (
          <View style={styles.missing}>
            <Text style={font.body}>This item is no longer available.</Text>
            <IconButton icon="close" label="Close" onPress={close} />
          </View>
        ) : (
          <Loading />
        )}
      </View>
    );
  }

  return (
    <View style={styles.screen} testID="viewer">
      <FlatList
        ref={listRef}
        data={items}
        horizontal
        pagingEnabled
        initialScrollIndex={startIndex}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        keyExtractor={(asset) => asset.id}
        showsHorizontalScrollIndicator={false}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={1}
        renderItem={({ item, index: itemIndex }) => (
          <Page
            asset={item}
            session={session}
            width={width}
            height={height}
            active={itemIndex === index}
            onTap={() => setChrome((visible) => !visible)}
          />
        )}
      />

      {chrome ? (
        <>
          <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
            <IconButton icon="chevron-back" label="Close viewer" onPress={close} testID="viewer-close" />
            <View style={styles.titleWrap}>
              <Text style={styles.title} numberOfLines={1} testID="viewer-title">
                {formatDateTime(current.taken_at)}
              </Text>
              <Text style={font.tiny}>
                {index + 1} of {items.length}
              </Text>
            </View>
            <IconButton
              icon={info ? 'information-circle' : 'information-circle-outline'}
              label="Show details"
              onPress={() => setInfo((visible) => !visible)}
              testID="viewer-info"
            />
          </View>

          {Platform.OS === 'web' && index > 0 ? (
            <View style={[styles.arrow, styles.arrowLeft]}>
              <IconButton icon="chevron-back-circle" label="Previous" size={40} onPress={() => goTo(index - 1)} testID="viewer-prev" />
            </View>
          ) : null}
          {Platform.OS === 'web' && index < items.length - 1 ? (
            <View style={[styles.arrow, styles.arrowRight]}>
              <IconButton icon="chevron-forward-circle" label="Next" size={40} onPress={() => goTo(index + 1)} testID="viewer-next" />
            </View>
          ) : null}

          {info ? (
            <View style={[styles.infoPanel, { bottom: insets.bottom + 84 }]} testID="viewer-details">
              <Text style={font.body} numberOfLines={2}>
                {current.original_name}
              </Text>
              <Text style={font.small}>
                {[
                  formatBytes(current.size_bytes),
                  current.width && current.height ? `${current.width} × ${current.height}` : null,
                  current.duration_s ? formatDuration(current.duration_s) : null,
                ]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
              {current.lat != null && current.lon != null ? (
                <Text style={font.small}>
                  Location: {current.lat.toFixed(4)}, {current.lon.toFixed(4)}
                </Text>
              ) : null}
              {current.status === 'failed' ? (
                <Text style={[font.small, { color: colors.warning }]}>
                  A preview could not be made for this file. The original is safe.
                </Text>
              ) : null}
            </View>
          ) : null}

          <View style={[styles.bottomBar, { paddingBottom: insets.bottom + spacing.md }]}>
            {current.deleted_at ? (
              <Action icon="arrow-undo-outline" label="Restore" onPress={restore} disabled={busy} testID="viewer-restore" />
            ) : (
              <>
                <Action
                  icon="download-outline"
                  label={canSaveToCameraRoll ? 'Save' : 'Download'}
                  onPress={() => run(() => saveToDevice(current))}
                  disabled={busy}
                  testID="viewer-save"
                />
                {Platform.OS !== 'web' ? (
                  <Action
                    icon="share-outline"
                    label="Share"
                    onPress={() => run(() => shareAsset(current))}
                    disabled={busy}
                    testID="viewer-share"
                  />
                ) : null}
              </>
            )}
            <Action
              icon="trash-outline"
              label={current.deleted_at ? 'Delete forever' : 'Delete'}
              onPress={remove}
              disabled={busy}
              color={colors.danger}
              testID="viewer-delete"
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function Action({
  icon,
  label,
  onPress,
  disabled,
  color = colors.text,
  testID,
}: {
  icon: React.ComponentProps<typeof IconButton>['icon'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  color?: string;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      <Ionicons name={icon} size={24} color={color} />
      <Text style={[font.tiny, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Page({
  asset,
  session,
  width,
  height,
  active,
  onTap,
}: {
  asset: Asset;
  session: Session | null;
  width: number;
  height: number;
  active: boolean;
  onTap: () => void;
}) {
  const frame = { width, height };
  if (asset.kind === 'video' && active) {
    return (
      <View style={frame}>
        <VideoPage asset={asset} session={session} />
      </View>
    );
  }
  // Photos show the 1440px preview. A HEIC original would not display in a browser, and the
  // preview loads far faster over a remote connection.
  const source =
    asset.status === 'ready'
      ? thumbSource(session, asset.id, 'preview')
      : originalSource(session, asset.id);
  return (
    // On iOS a ScrollView gives native pinch-to-zoom and double-tap-free panning.
    <ScrollView
      style={frame}
      contentContainerStyle={styles.zoomContent}
      maximumZoomScale={asset.kind === 'photo' ? 5 : 1}
      minimumZoomScale={1}
      bouncesZoom
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}>
      <Pressable onPress={onTap} accessibilityLabel={`${asset.kind} ${asset.original_name}`}>
        <Image
          source={source}
          placeholder={thumbSource(session, asset.id, 'thumb')}
          placeholderContentFit="contain"
          style={frame}
          contentFit="contain"
          transition={150}
          testID={`viewer-image-${asset.id}`}
        />
      </Pressable>
    </ScrollView>
  );
}

function VideoPage({ asset, session }: { asset: Asset; session: Session | null }) {
  // The original file is streamed with HTTP Range requests, so seeking works without
  // downloading the whole video first.
  const player = useVideoPlayer(originalSource(session, asset.id), (instance) => {
    instance.loop = false;
    instance.play();
  });
  return (
    <VideoView
      player={player}
      style={styles.video}
      contentFit="contain"
      nativeControls
      testID={`viewer-video-${asset.id}`}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000000' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  zoomContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  video: { flex: 1, backgroundColor: '#000000' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  titleWrap: { flex: 1, alignItems: 'center' },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  action: { alignItems: 'center', minWidth: 72, gap: 2 },
  arrow: { position: 'absolute', top: '50%', marginTop: -24 },
  arrowLeft: { left: spacing.md },
  arrowRight: { right: spacing.md },
  infoPanel: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    maxWidth: 520,
    alignSelf: 'center',
    backgroundColor: 'rgba(21,24,29,0.95)',
    borderRadius: 14,
    padding: spacing.lg,
    gap: spacing.xs,
  },
});
