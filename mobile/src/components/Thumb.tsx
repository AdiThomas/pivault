/** One square cell in a photo grid. */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { thumbSource } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { formatDuration } from '@/lib/format';
import { colors } from '@/lib/theme';
import type { Asset } from '@/lib/types';

type Props = {
  asset: Asset;
  size: number;
  session: Session | null;
  selected?: boolean;
  selecting?: boolean;
  onPress: (asset: Asset) => void;
  onLongPress?: (asset: Asset) => void;
};

function label(asset: Asset): string {
  const kind = asset.kind === 'video' ? 'Video' : asset.kind === 'photo' ? 'Photo' : 'File';
  return `${kind} ${asset.original_name}`;
}

export const Thumb = memo(function Thumb({
  asset,
  size,
  session,
  selected = false,
  selecting = false,
  onPress,
  onLongPress,
}: Props) {
  const ready = asset.status === 'ready' && asset.kind !== 'file';
  return (
    <Pressable
      testID={`thumb-${asset.id}`}
      accessibilityRole="imagebutton"
      accessibilityLabel={label(asset)}
      accessibilityState={{ selected }}
      onPress={() => onPress(asset)}
      onLongPress={onLongPress ? () => onLongPress(asset) : undefined}
      style={[styles.cell, { width: size, height: size }]}>
      {ready ? (
        <Image
          source={thumbSource(session, asset.id, 'thumb')}
          style={styles.image}
          contentFit="cover"
          recyclingKey={asset.id}
          cachePolicy="memory-disk"
          transition={120}
        />
      ) : (
        <View style={styles.placeholder}>
          {asset.status === 'processing' ? (
            <ActivityIndicator color={colors.textFaint} />
          ) : (
            <Ionicons
              name={asset.status === 'failed' ? 'alert-circle-outline' : 'document-outline'}
              size={24}
              color={colors.textFaint}
            />
          )}
        </View>
      )}
      {asset.kind === 'video' ? (
        <View style={styles.badge}>
          <Ionicons name="play" size={10} color="#FFFFFF" />
          <Text style={styles.badgeText}>{formatDuration(asset.duration_s)}</Text>
        </View>
      ) : null}
      {selecting ? (
        <View style={[styles.check, selected && styles.checkOn]}>
          {selected ? <Ionicons name="checkmark" size={14} color="#FFFFFF" /> : null}
        </View>
      ) : null}
      {selected ? <View style={styles.selectedTint} pointerEvents="none" /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  cell: { padding: 1 },
  image: { flex: 1, backgroundColor: colors.surface },
  placeholder: {
    flex: 1,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },
  check: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  selectedTint: {
    position: 'absolute',
    top: 1,
    left: 1,
    right: 1,
    bottom: 1,
    backgroundColor: 'rgba(79,140,255,0.25)',
  },
});
