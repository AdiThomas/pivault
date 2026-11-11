import { Ionicons } from '@expo/vector-icons';
import { useRef, useState, type ComponentRef } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { signIn, useAuth } from '@/lib/auth';
import { errorText } from '@/lib/dialogs';
import { normalizeServerUrl } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import { colors, font, radius, spacing } from '@/lib/theme';

/** A sensible starting value for the server field. */
function defaultServer(lastServerUrl: string): string {
  if (lastServerUrl) return lastServerUrl;
  if (process.env.EXPO_PUBLIC_DEFAULT_SERVER) return process.env.EXPO_PUBLIC_DEFAULT_SERVER;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // Served by the Pi itself: the API is on the same address. In local development the
    // web app runs on Expo's port and the API on 8000.
    const { origin, port, hostname } = window.location;
    return port === '8081' || port === '19006' ? `http://${hostname}:8000` : origin;
  }
  return '';
}

export default function LoginScreen() {
  const lastServerUrl = useAuth((state) => state.lastServerUrl);
  const [server, setServer] = useState(() => defaultServer(lastServerUrl));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<ComponentRef<typeof TextInput>>(null);
  const passwordRef = useRef<ComponentRef<typeof TextInput>>(null);

  const submit = async () => {
    const url = normalizeServerUrl(server);
    if (!url) return setError('Enter your server address, for example pivault.your-tailnet.ts.net');
    if (!email.trim() || !password) return setError('Enter your email and password');
    setBusy(true);
    setError(null);
    try {
      // Check the address first so a typo gets a clearer message than "login failed".
      try {
        await api.health(url);
      } catch {
        throw new Error(
          `Can't reach a PiVault server at ${url}. Check the address, and that Tailscale is connected on this device.`,
        );
      }
      await signIn(url, email.trim(), password);
      haptics.success();
    } catch (err) {
      haptics.warning();
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.logo}>
            <Ionicons name="lock-closed" size={36} color={colors.accent} />
          </View>
          <Text style={[font.title, styles.center]}>PiVault</Text>
          <Text style={[font.small, styles.center, styles.tagline]}>
            Your photos, videos and files, on your own Raspberry Pi.
          </Text>

          <Text style={styles.label}>Server address</Text>
          <TextInput
            testID="login-server"
            accessibilityLabel="Server address"
            style={styles.input}
            value={server}
            onChangeText={setServer}
            placeholder="pivault.your-tailnet.ts.net"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="next"
            onSubmitEditing={() => emailRef.current?.focus()}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            ref={emailRef}
            testID="login-email"
            accessibilityLabel="Email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            ref={passwordRef}
            testID="login-password"
            accessibilityLabel="Password"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
          />

          {error ? (
            <Text style={styles.error} accessibilityRole="alert" testID="login-error">
              {error}
            </Text>
          ) : null}

          <Button
            label="Log in"
            onPress={submit}
            loading={busy}
            testID="login-submit"
            style={styles.submit}
          />
          <Text style={[font.tiny, styles.center, styles.hint]}>
            Away from home? Connect Tailscale first, then use your Pi&apos;s ts.net address.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: colors.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: spacing.lg,
  },
  center: { textAlign: 'center' },
  tagline: { marginTop: spacing.sm, marginBottom: spacing.xl },
  label: { ...font.small, marginTop: spacing.lg, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    minHeight: 50,
  },
  error: { color: colors.danger, fontSize: 14, marginTop: spacing.lg, lineHeight: 20 },
  submit: { marginTop: spacing.xl },
  hint: { marginTop: spacing.lg, lineHeight: 16 },
});
