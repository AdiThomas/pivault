/** Renders the confirm / prompt / action-sheet dialogs and toasts from lib/dialogs. */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { closeDialog, useDialogs, type DialogRequest } from '@/lib/dialogs';
import { colors, font, radius, spacing } from '@/lib/theme';

import { Button, type IconName } from './ui';

export function DialogHost() {
  const current = useDialogs((state) => state.current);
  const toast = useDialogs((state) => state.toast);
  return (
    <>
      {current ? <Dialog key={dialogKey(current)} request={current} /> : null}
      {toast ? (
        <View pointerEvents="none" style={styles.toastWrap}>
          <View
            testID="toast"
            accessibilityRole="alert"
            style={[styles.toast, toast.tone === 'error' && styles.toastError]}>
            <Text style={styles.toastText}>{toast.message}</Text>
          </View>
        </View>
      ) : null}
    </>
  );
}

function dialogKey(request: DialogRequest): string {
  return `${request.type}:${'title' in request ? request.title : ''}`;
}

function Dialog({ request }: { request: DialogRequest }) {
  const [text, setText] = useState(request.type === 'prompt' ? request.initialValue : '');

  const cancel = () => {
    if (request.type === 'confirm') request.resolve(false);
    else request.resolve(null);
    closeDialog();
  };

  // Escape closes the dialog in a browser.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (request.type === 'sheet') {
    return (
      <Modal transparent animationType="fade" onRequestClose={cancel} visible>
        <Pressable style={styles.sheetBackdrop} onPress={cancel} accessibilityLabel="Close menu">
          <Pressable style={styles.sheet} onPress={() => undefined} testID="action-sheet">
            {request.title ? (
              <Text style={[font.small, styles.sheetTitle]} numberOfLines={1}>
                {request.title}
              </Text>
            ) : null}
            {request.options.map((option) => (
              <Pressable
                key={option.key}
                testID={`sheet-${option.key}`}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                onPress={() => {
                  request.resolve(option.key);
                  closeDialog();
                }}
                style={({ pressed }) => [styles.sheetOption, pressed && styles.pressed]}>
                {option.icon ? (
                  <Ionicons
                    name={option.icon as IconName}
                    size={20}
                    color={option.destructive ? colors.danger : colors.textDim}
                  />
                ) : null}
                <Text style={[font.body, option.destructive && { color: colors.danger }]}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
            <Button label="Cancel" variant="secondary" onPress={cancel} style={styles.sheetCancel} />
          </Pressable>
        </Pressable>
      </Modal>
    );
  }

  const confirm = () => {
    if (request.type === 'confirm') request.resolve(true);
    else request.resolve(text.trim() ? text.trim() : null);
    closeDialog();
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={cancel} visible>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.dialog} testID="dialog" accessibilityRole="alert">
          <Text style={font.heading}>{request.title}</Text>
          {request.message ? <Text style={[font.small, styles.message]}>{request.message}</Text> : null}
          {request.type === 'prompt' ? (
            <TextInput
              testID="dialog-input"
              accessibilityLabel={request.title}
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={request.placeholder}
              placeholderTextColor={colors.textFaint}
              secureTextEntry={request.secure}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              selectTextOnFocus
              onSubmitEditing={confirm}
              returnKeyType="done"
            />
          ) : null}
          <View style={styles.actions}>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={cancel}
              style={styles.action}
              testID="dialog-cancel"
            />
            <Button
              label={request.confirmLabel}
              variant={request.type === 'confirm' && request.destructive ? 'danger' : 'primary'}
              onPress={confirm}
              disabled={request.type === 'prompt' && !text.trim()}
              style={styles.action}
              testID="dialog-confirm"
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  message: { marginTop: spacing.sm, lineHeight: 19 },
  input: {
    marginTop: spacing.lg,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    minHeight: 48,
  },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  action: { flex: 1 },
  sheetBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end', alignItems: 'center' },
  sheet: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  sheetTitle: { textAlign: 'center', marginBottom: spacing.sm },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  sheetCancel: { marginTop: spacing.md },
  pressed: { backgroundColor: colors.surfaceRaised },
  toastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 110,
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  toast: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    maxWidth: 480,
  },
  toastError: { borderColor: colors.danger },
  toastText: { color: colors.text, fontSize: 14, textAlign: 'center' },
});
