import { StyleSheet, Text, View } from 'react-native';

import { colors, font, radius, spacing } from '@/lib/theme';
import { useUploader } from '@/lib/uploader';

import { ProgressBar } from './ui';

/** A slim progress strip shown while manual uploads are running. */
export function UploadBanner() {
  const { active, done, total, currentName, fraction } = useUploader();
  if (!active) return null;
  return (
    <View style={styles.banner} testID="upload-banner">
      <Text style={font.small} numberOfLines={1}>
        Uploading {Math.min(done + 1, total)} of {total}
        {currentName ? `: ${currentName}` : ''}
      </Text>
      <ProgressBar fraction={(done + fraction) / Math.max(1, total)} />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
});
