/** Backup tab: progress ring, "Back up now" and the backup switches. */
import { useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ProgressRing } from '@/components/ProgressRing';
import { UploadBanner } from '@/components/UploadBanner';
import { Button, Card, Divider, ProgressBar, Screen, SectionTitle, ToggleRow } from '@/components/ui';
import { backgroundSupport, setBackgroundBackup, type BackgroundSupport } from '@/lib/backgroundTask';
import { backupSupported, reviewPhotoAccess, runBackup, stopBackup } from '@/lib/backup';
import { isRunning, useBackup, type BackupState } from '@/lib/backupState';
import { toast } from '@/lib/dialogs';
import { formatRelative } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import { updateSettings, useSettings } from '@/lib/settings';
import { colors, font, spacing } from '@/lib/theme';
import { pickAndUpload } from '@/lib/uploader';

function headline(state: BackupState): string {
  switch (state.phase) {
    case 'scanning':
      return 'Looking through your camera roll';
    case 'checking':
      return 'Checking with your server';
    case 'uploading':
      return `Uploading ${state.remaining} item${state.remaining === 1 ? '' : 's'}`;
    case 'done':
      return state.total > 0 && state.backedUp >= state.total
        ? 'Everything is backed up'
        : 'Backup finished';
    case 'needsPermission':
      return 'Photo access needed';
    case 'waitingForWifi':
      return 'Waiting for Wi-Fi';
    case 'error':
      return 'Backup ran into a problem';
    case 'unsupported':
      return 'Backup runs on your iPhone';
    default:
      return 'Ready to back up';
  }
}

export default function BackupScreen() {
  const backup = useBackup();
  const settings = useSettings();
  const [bgSupport, setBgSupport] = useState<BackgroundSupport>('unavailable');
  const running = isRunning(backup.phase);
  const fraction = backup.total > 0 ? backup.backedUp / backup.total : 0;
  const complete = backup.total > 0 && backup.backedUp >= backup.total;

  useEffect(() => {
    backgroundSupport().then(setBgSupport);
  }, []);

  const toggleBackground = async (enabled: boolean) => {
    haptics.tap();
    const ok = await setBackgroundBackup(enabled);
    if (!ok && enabled) {
      toast(
        'Background backup needs your own build of the app. It is not available in Expo Go.',
        'error',
      );
      return;
    }
    await updateSettings({ backgroundBackup: enabled });
  };

  if (!backupSupported) {
    return (
      <Screen title="Backup">
        <ScrollView contentContainerStyle={styles.content}>
          <UploadBanner />
          <Card style={styles.center}>
            <Text style={font.heading} testID="backup-headline">
              {headline({ ...backup, phase: 'unsupported' })}
            </Text>
            <Text style={[font.small, styles.explain]}>
              Automatic camera-roll backup is part of the PiVault iPhone app. In a browser you can
              still upload photos and videos by hand, and they appear in your timeline.
            </Text>
            <Button
              label="Upload photos and videos"
              icon="add"
              onPress={() => pickAndUpload(null)}
              testID="backup-web-upload"
              style={styles.fullWidth}
            />
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen title="Backup">
      <ScrollView contentContainerStyle={styles.content}>
        <Card style={styles.center}>
          <ProgressRing fraction={fraction} color={complete ? colors.success : colors.accent}>
            <Text style={styles.count} testID="backup-count">
              {backup.backedUp.toLocaleString()}
            </Text>
            <Text style={font.small}>of {backup.total.toLocaleString()} backed up</Text>
          </ProgressRing>

          <Text style={[font.heading, styles.headline]} testID="backup-headline">
            {headline(backup)}
          </Text>
          {backup.message ? <Text style={[font.small, styles.explain]}>{backup.message}</Text> : null}

          {backup.phase === 'uploading' && backup.currentName ? (
            <View style={styles.current}>
              <Text style={font.small} numberOfLines={1}>
                {backup.currentName}
              </Text>
              <ProgressBar fraction={backup.currentProgress} />
            </View>
          ) : null}

          {running ? (
            <Button
              label="Pause"
              icon="pause"
              variant="secondary"
              onPress={stopBackup}
              style={styles.fullWidth}
              testID="backup-stop"
            />
          ) : backup.phase === 'needsPermission' ? (
            <View style={styles.fullWidth}>
              <Button label="Allow photo access" onPress={() => runBackup('manual')} testID="backup-allow" />
              <Button label="Open Settings" variant="ghost" onPress={() => Linking.openSettings()} />
            </View>
          ) : (
            <Button
              label="Back up now"
              icon="cloud-upload-outline"
              onPress={() => {
                haptics.tap();
                runBackup('manual');
              }}
              style={styles.fullWidth}
              testID="backup-start"
            />
          )}
          <Text style={font.tiny}>Last backup: {formatRelative(settings.lastBackupAt)}</Text>
        </Card>

        {backup.limitedAccess ? (
          <Card style={styles.notice}>
            <Text style={font.body}>Only selected photos are shared</Text>
            <Text style={[font.small, styles.explain]}>
              PiVault can only back up the photos you picked. Allow access to all photos to back up
              your whole camera roll.
            </Text>
            <Button label="Change selection" variant="secondary" onPress={reviewPhotoAccess} />
          </Card>
        ) : null}

        <SectionTitle>Options</SectionTitle>
        <Card>
          <ToggleRow
            icon="wifi-outline"
            label="Wi-Fi only"
            detail="Don't use mobile data for backup"
            value={settings.wifiOnly}
            onChange={(wifiOnly) => updateSettings({ wifiOnly })}
            testID="backup-wifi-only"
          />
          <Divider />
          <ToggleRow
            icon="videocam-outline"
            label="Include videos"
            detail="Videos are large: roughly 400 MB per minute of 4K"
            value={settings.includeVideos}
            onChange={(includeVideos) => updateSettings({ includeVideos })}
            testID="backup-include-videos"
          />
          <Divider />
          <ToggleRow
            icon="open-outline"
            label="Back up when I open the app"
            detail="The most reliable way to back up on iPhone"
            value={settings.backupOnOpen}
            onChange={(backupOnOpen) => updateSettings({ backupOnOpen })}
            testID="backup-on-open"
          />
          <Divider />
          <ToggleRow
            icon="moon-outline"
            label="Background backup"
            detail={
              bgSupport === 'available'
                ? 'iOS chooses when, often overnight while charging'
                : 'Needs your own build of the app (not Expo Go)'
            }
            value={settings.backgroundBackup}
            onChange={toggleBackground}
            testID="backup-background"
          />
        </Card>

        <Text style={[font.tiny, styles.footnote]}>
          Photos are sent straight to your Pi over Tailscale. Keep iCloud Photos on until you have
          tested restoring from your Pi&apos;s backups.
        </Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  center: { alignItems: 'center', gap: spacing.md },
  count: { fontSize: 40, fontWeight: '700', color: colors.text },
  headline: { marginTop: spacing.sm, textAlign: 'center' },
  explain: { textAlign: 'center', lineHeight: 19 },
  current: { alignSelf: 'stretch', gap: spacing.sm },
  fullWidth: { alignSelf: 'stretch', gap: spacing.sm },
  notice: { marginTop: spacing.lg, gap: spacing.sm },
  footnote: { marginTop: spacing.lg, textAlign: 'center', lineHeight: 16 },
});
