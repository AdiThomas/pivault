/**
 * Small key-value store for the session and settings.
 * On iOS and Android this is the Keychain / Keystore (expo-secure-store).
 * The web build uses storage.web.ts instead.
 */
import * as SecureStore from 'expo-secure-store';

export async function getItem(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  // AFTER_FIRST_UNLOCK lets the background backup task read the session while the
  // phone is locked (the default would only allow it while unlocked).
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
}

export async function removeItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Nothing stored.
  }
}
