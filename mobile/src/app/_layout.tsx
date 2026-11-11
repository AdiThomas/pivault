import { QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { DialogHost } from '@/components/DialogHost';
import { hydrateAuth, onSignOut, startTokenKeepAlive, useAuth } from '@/lib/auth';
// Importing this module registers the background backup task with the system.
import '@/lib/backgroundTask';
import { resetBackup, runBackup } from '@/lib/backup';
import { queryClient } from '@/lib/queries';
import { hydrateSettings, resetAccountSettings, useSettings } from '@/lib/settings';
import { colors } from '@/lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bg,
    border: colors.border,
    primary: colors.accent,
    text: colors.text,
  },
};

/** Don't start another automatic backup pass more often than this. */
const AUTO_BACKUP_GAP_MS = 5 * 60_000;

export default function RootLayout() {
  const status = useAuth((state) => state.status);
  const settingsLoaded = useSettings((state) => state.loaded);
  const lastAutoBackup = useRef(0);

  useEffect(() => {
    hydrateAuth().catch(() => useAuth.setState({ status: 'signedOut' }));
    hydrateSettings().catch(() => useSettings.setState({ loaded: true }));
    // Logging out wipes everything tied to the account.
    return onSignOut(async () => {
      queryClient.clear();
      await resetBackup();
      await resetAccountSettings();
    });
  }, []);

  const ready = status !== 'loading' && settingsLoaded;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);

  useEffect(() => {
    if (status !== 'signedIn') return;
    return startTokenKeepAlive();
  }, [status]);

  // The reliable part of backup on iOS: run a pass every time the app comes forward.
  useEffect(() => {
    if (!ready || status !== 'signedIn') return;
    const maybeBackup = () => {
      if (!useSettings.getState().backupOnOpen) return;
      if (Date.now() - lastAutoBackup.current < AUTO_BACKUP_GAP_MS) return;
      lastAutoBackup.current = Date.now();
      runBackup('open').catch(() => undefined);
    };
    maybeBackup();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') maybeBackup();
    });
    return () => subscription.remove();
  }, [ready, status]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider value={navTheme}>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.bg },
            }}>
            <Stack.Protected guard={status === 'signedIn'}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen
                name="viewer/[id]"
                options={{ presentation: 'fullScreenModal', animation: 'fade' }}
              />
              <Stack.Screen name="trash" />
            </Stack.Protected>
            <Stack.Protected guard={status !== 'signedIn'}>
              <Stack.Screen name="login" />
            </Stack.Protected>
          </Stack>
          <DialogHost />
          <StatusBar style="light" />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
