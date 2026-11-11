/** Settings tab: server, account, storage and housekeeping. */
import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Divider, ProgressBar, Row, Screen, SectionTitle } from '@/components/ui';
import { api } from '@/lib/api';
import { signOut, useAuth } from '@/lib/auth';
import { resetBackup } from '@/lib/backup';
import { confirm, errorText, prompt, toast } from '@/lib/dialogs';
import { formatBytes } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import { colors, font, spacing } from '@/lib/theme';

export default function SettingsScreen() {
  const session = useAuth((state) => state.session);
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, staleTime: 10_000 });
  const health = useQuery({
    queryKey: ['health', session?.serverUrl],
    queryFn: () => api.health(session?.serverUrl ?? ''),
    enabled: !!session,
    staleTime: 60_000,
  });

  const data = stats.data;
  const diskUsed = data ? data.disk_total - data.disk_free : 0;
  const diskFraction = data && data.disk_total > 0 ? diskUsed / data.disk_total : 0;
  const nearlyFull = diskFraction > 0.9;

  const logOut = async () => {
    const ok = await confirm({
      title: 'Log out?',
      message: 'Your photos stay on your Pi. This device forgets what it has backed up.',
      confirmLabel: 'Log out',
      destructive: true,
    });
    if (ok) await signOut();
  };

  const changePassword = async () => {
    const current = await prompt({
      title: 'Current password',
      secure: true,
      confirmLabel: 'Next',
    });
    if (!current) return;
    const next = await prompt({
      title: 'New password',
      message: 'At least 8 characters. Other devices will be logged out.',
      secure: true,
      confirmLabel: 'Change password',
    });
    if (!next) return;
    if (next.length < 8) return toast('Use at least 8 characters', 'error');
    try {
      await api.changePassword(current, next);
      toast('Password changed. Log in again.');
      await signOut({ revoke: false });
    } catch (error) {
      toast(errorText(error), 'error');
    }
  };

  const clearCache = async () => {
    await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]).catch(() => undefined);
    haptics.success();
    toast('Image cache cleared');
  };

  const recheck = async () => {
    const ok = await confirm({
      title: 'Check every photo again?',
      message:
        'The next backup asks your server about the whole camera roll instead of only new photos. Nothing is uploaded twice.',
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    await resetBackup();
    toast('Backup record cleared');
  };

  return (
    <Screen title="Settings">
      <ScrollView contentContainerStyle={styles.content}>
        <SectionTitle>Storage</SectionTitle>
        <Card>
          {data ? (
            <View style={styles.storage} testID="storage-card">
              <View style={styles.storageHead}>
                <Text style={font.heading} testID="storage-used">
                  {formatBytes(data.bytes_used)}
                </Text>
                <Text style={font.small}>in your vault</Text>
              </View>
              <ProgressBar fraction={diskFraction} color={nearlyFull ? colors.danger : colors.accent} />
              <Text style={[font.small, nearlyFull && { color: colors.danger }]} testID="storage-free">
                {formatBytes(data.disk_free)} free of {formatBytes(data.disk_total)} on the Pi
                {nearlyFull ? '. Nearly full.' : ''}
              </Text>
              <Divider />
              <View style={styles.counts}>
                <Count label="Photos" value={data.photos} testID="count-photos" />
                <Count label="Videos" value={data.videos} testID="count-videos" />
                <Count label="Files" value={data.files} testID="count-files" />
              </View>
              {data.processing > 0 ? (
                <Text style={font.small}>
                  {data.processing} item{data.processing === 1 ? ' is' : 's are'} still being processed.
                </Text>
              ) : null}
              {data.failed > 0 ? (
                <Text style={[font.small, { color: colors.warning }]}>
                  {data.failed} item{data.failed === 1 ? '' : 's'} could not be previewed. The originals
                  are safe.
                </Text>
              ) : null}
            </View>
          ) : (
            <Text style={font.small}>
              {stats.isError ? `Couldn't load storage: ${errorText(stats.error)}` : 'Loading...'}
            </Text>
          )}
        </Card>

        <SectionTitle>Library</SectionTitle>
        <Card>
          <Row
            icon="trash-outline"
            label="Trash"
            value={data ? `${data.trashed} item${data.trashed === 1 ? '' : 's'}` : undefined}
            onPress={() => router.push('/trash')}
            testID="open-trash"
          />
        </Card>

        <SectionTitle>Server</SectionTitle>
        <Card>
          <Row icon="server-outline" label="Address" value={session?.serverUrl} />
          <Divider />
          <Row
            icon="pulse-outline"
            label="Status"
            value={
              health.isPending
                ? 'Checking...'
                : health.isError
                  ? 'Unreachable'
                  : health.data?.status === 'ok'
                    ? `Healthy (v${health.data.version})`
                    : 'Degraded'
            }
          />
        </Card>

        <SectionTitle>Account</SectionTitle>
        <Card>
          <Row icon="person-outline" label="Signed in as" value={session?.email} />
          <Divider />
          <Row icon="key-outline" label="Change password" onPress={changePassword} testID="change-password" />
          <Divider />
          <Row icon="log-out-outline" label="Log out" onPress={logOut} destructive testID="logout" />
        </Card>

        <SectionTitle>This device</SectionTitle>
        <Card>
          <Row icon="images-outline" label="Clear image cache" onPress={clearCache} testID="clear-cache" />
          <Divider />
          <Row icon="refresh-outline" label="Check every photo again" onPress={recheck} />
        </Card>

        <Text style={[font.tiny, styles.version]}>
          PiVault {Application.nativeApplicationVersion ?? '1.0.0'}
        </Text>
      </ScrollView>
    </Screen>
  );
}

function Count({ label, value, testID }: { label: string; value: number; testID: string }) {
  return (
    <View style={styles.count}>
      <Text style={font.heading} testID={testID}>
        {value.toLocaleString()}
      </Text>
      <Text style={font.small}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  storage: { gap: spacing.sm },
  storageHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  counts: { flexDirection: 'row', justifyContent: 'space-around' },
  count: { alignItems: 'center', gap: 2 },
  version: { textAlign: 'center', marginTop: spacing.xl },
});
