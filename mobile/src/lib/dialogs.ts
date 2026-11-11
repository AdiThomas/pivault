/**
 * Confirm, prompt, action-sheet and toast helpers that work the same on iOS and the web.
 * (React Native's Alert does nothing in a browser, and Alert.prompt is iOS-only.)
 * The UI lives in components/DialogHost.tsx.
 */
import { create } from 'zustand';

export type SheetOption = {
  key: string;
  label: string;
  icon?: string;
  destructive?: boolean;
};

export type DialogRequest =
  | {
      type: 'confirm';
      title: string;
      message?: string;
      confirmLabel: string;
      destructive: boolean;
      resolve: (value: boolean) => void;
    }
  | {
      type: 'prompt';
      title: string;
      message?: string;
      initialValue: string;
      placeholder?: string;
      confirmLabel: string;
      secure: boolean;
      resolve: (value: string | null) => void;
    }
  | {
      type: 'sheet';
      title?: string;
      options: SheetOption[];
      resolve: (value: string | null) => void;
    };

type DialogState = {
  current: DialogRequest | null;
  toast: { id: number; message: string; tone: 'info' | 'error' } | null;
};

export const useDialogs = create<DialogState>(() => ({ current: null, toast: null }));

function show(request: DialogRequest): void {
  // A new dialog replaces the current one; cancel the old one so its promise settles.
  const previous = useDialogs.getState().current;
  if (previous) dismiss(previous);
  useDialogs.setState({ current: request });
}

function dismiss(request: DialogRequest): void {
  if (request.type === 'confirm') request.resolve(false);
  else request.resolve(null);
}

export function closeDialog(): void {
  useDialogs.setState({ current: null });
}

export function confirm(options: {
  title: string;
  message?: string;
  confirmLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) =>
    show({
      type: 'confirm',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? 'OK',
      destructive: options.destructive ?? false,
      resolve,
    }),
  );
}

export function prompt(options: {
  title: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  secure?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) =>
    show({
      type: 'prompt',
      title: options.title,
      message: options.message,
      initialValue: options.initialValue ?? '',
      placeholder: options.placeholder,
      confirmLabel: options.confirmLabel ?? 'Save',
      secure: options.secure ?? false,
      resolve,
    }),
  );
}

export function actionSheet(options: {
  title?: string;
  options: SheetOption[];
}): Promise<string | null> {
  return new Promise((resolve) =>
    show({ type: 'sheet', title: options.title, options: options.options, resolve }),
  );
}

let toastCounter = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  toastCounter += 1;
  const id = toastCounter;
  useDialogs.setState({ toast: { id, message, tone } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      if (useDialogs.getState().toast?.id === id) useDialogs.setState({ toast: null });
    },
    tone === 'error' ? 5000 : 2500,
  );
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong';
}
