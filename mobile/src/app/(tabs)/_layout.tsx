import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router/js-tabs';
import { Platform, type ColorValue } from 'react-native';

import type { IconName } from '@/components/ui';
import { colors } from '@/lib/theme';

/** A tab icon that is filled when its tab is selected and outlined otherwise. */
function icon(active: IconName, inactive: IconName) {
  function TabIcon({ color, focused, size }: { color: ColorValue; focused: boolean; size: number }) {
    return <Ionicons name={focused ? active : inactive} size={size} color={color as string} />;
  }
  return TabIcon;
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.border,
          // Browsers have no home-indicator inset, so give the labels room.
          ...(Platform.OS === 'web' ? { height: 62, paddingBottom: 8, paddingTop: 6 } : null),
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        sceneStyle: { backgroundColor: colors.bg },
      }}>
      <Tabs.Screen
        name="index"
        options={{ title: 'Photos', tabBarIcon: icon('images', 'images-outline') }}
      />
      <Tabs.Screen
        name="files"
        options={{ title: 'Files', tabBarIcon: icon('folder', 'folder-outline') }}
      />
      <Tabs.Screen
        name="backup"
        options={{ title: 'Backup', tabBarIcon: icon('cloud-upload', 'cloud-upload-outline') }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: icon('settings', 'settings-outline') }}
      />
    </Tabs>
  );
}
