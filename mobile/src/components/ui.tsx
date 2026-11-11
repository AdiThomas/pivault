/** Small shared building blocks. */
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, font, maxContentWidth, radius, spacing } from '@/lib/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Screen({
  title,
  right,
  children,
  wide = false,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  /** Use the full width (photo grids) instead of a centred column. */
  wide?: boolean;
}) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <View style={[styles.header, !wide && styles.column]}>
        <Text style={font.title} accessibilityRole="header">
          {title}
        </Text>
        <View style={styles.headerRight}>{right}</View>
      </View>
      <View style={[styles.body, !wide && styles.column]}>{children}</View>
    </SafeAreaView>
  );
}

export function Button({
  label,
  onPress,
  icon,
  variant = 'primary',
  disabled = false,
  loading = false,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = {
    primary: { bg: colors.accent, fg: '#FFFFFF' },
    secondary: { bg: colors.surfaceRaised, fg: colors.text },
    danger: { bg: '#3A1A1A', fg: colors.danger },
    ghost: { bg: 'transparent', fg: colors.accent },
  }[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: palette.bg, opacity: inactive ? 0.5 : pressed ? 0.8 : 1 },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={palette.fg} /> : null}
          <Text style={[styles.buttonLabel, { color: palette.fg }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export function IconButton({
  icon,
  label,
  onPress,
  color = colors.text,
  size = 24,
  testID,
  disabled = false,
}: {
  icon: IconName;
  /** Read by screen readers; not shown. */
  label: string;
  onPress: () => void;
  color?: string;
  size?: number;
  testID?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Row({
  icon,
  label,
  detail,
  value,
  onPress,
  right,
  destructive = false,
  testID,
}: {
  icon?: IconName;
  label: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  right?: ReactNode;
  destructive?: boolean;
  testID?: string;
}) {
  const tint = destructive ? colors.danger : colors.text;
  const content = (
    <View style={styles.row}>
      {icon ? <Ionicons name={icon} size={20} color={destructive ? colors.danger : colors.textDim} /> : null}
      <View style={styles.rowText}>
        <Text style={[font.body, { color: tint }]}>{label}</Text>
        {detail ? <Text style={font.small}>{detail}</Text> : null}
      </View>
      {value ? (
        <Text style={[font.small, styles.rowValue]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress && !right ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
      ) : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {content}
    </Pressable>
  );
}

export function ToggleRow({
  icon,
  label,
  detail,
  value,
  onChange,
  disabled = false,
  testID,
}: {
  icon?: IconName;
  label: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Row
      icon={icon}
      label={label}
      detail={detail}
      right={
        <Switch
          testID={testID}
          accessibilityLabel={label}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ true: colors.accent, false: colors.border }}
          thumbColor="#FFFFFF"
        />
      }
    />
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={48} color={colors.textFaint} />
      <Text style={[font.heading, styles.emptyTitle]}>{title}</Text>
      {message ? <Text style={[font.small, styles.emptyMessage]}>{message}</Text> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export function Loading() {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.accent} size="large" />
    </View>
  );
}

export function ProgressBar({ fraction, color = colors.accent }: { fraction: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <View
      style={styles.barTrack}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}>
      <View style={[styles.barFill, { width: `${pct * 100}%`, backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  column: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  body: { flex: 1 },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  buttonLabel: { fontSize: 16, fontWeight: '600' },
  iconButton: { minWidth: 36, minHeight: 36, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sectionTitle: {
    ...font.small,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  rowText: { flex: 1, gap: 2 },
  rowValue: { maxWidth: '50%', textAlign: 'right' },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  emptyTitle: { marginTop: spacing.lg, textAlign: 'center' },
  emptyMessage: { marginTop: spacing.sm, textAlign: 'center', lineHeight: 19, maxWidth: 320 },
  emptyAction: { marginTop: spacing.xl },
  barTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: radius.pill },
});
