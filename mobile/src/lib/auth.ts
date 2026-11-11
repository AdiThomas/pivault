/** Login session: server address, tokens and who is signed in. */
import { create } from 'zustand';

import * as storage from './storage';
import type { TokenPair } from './types';

const SESSION_KEY = 'pivault.session';
const SERVER_KEY = 'pivault.server';
/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 90_000;

export type Session = {
  serverUrl: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  accessExpiresAt: number;
};

type AuthState = {
  status: 'loading' | 'signedOut' | 'signedIn';
  session: Session | null;
  /** Remembered after logout so the login form is pre-filled. */
  lastServerUrl: string;
};

export const useAuth = create<AuthState>(() => ({
  status: 'loading',
  session: null,
  lastServerUrl: '',
}));

export class AuthError extends Error {}

async function persist(session: Session | null): Promise<void> {
  if (session) {
    await storage.setItem(SESSION_KEY, JSON.stringify(session));
    await storage.setItem(SERVER_KEY, session.serverUrl);
  } else {
    await storage.removeItem(SESSION_KEY);
  }
}

/** Load the saved session at startup. Safe to call more than once. */
export async function hydrateAuth(): Promise<Session | null> {
  const current = useAuth.getState();
  if (current.status !== 'loading') return current.session;
  const [raw, lastServerUrl] = await Promise.all([
    storage.getItem(SESSION_KEY),
    storage.getItem(SERVER_KEY),
  ]);
  let session: Session | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Session;
      if (parsed.serverUrl && parsed.refreshToken) session = parsed;
    } catch {
      session = null;
    }
  }
  useAuth.setState({
    status: session ? 'signedIn' : 'signedOut',
    session,
    lastServerUrl: lastServerUrl ?? '',
  });
  return session;
}

function sessionFromTokens(serverUrl: string, email: string, tokens: TokenPair): Session {
  return {
    serverUrl,
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

async function readError(resp: Response, fallback: string): Promise<string> {
  try {
    const body = await resp.json();
    if (typeof body?.detail === 'string') return body.detail;
  } catch {
    // Not JSON.
  }
  return fallback;
}

export async function signIn(serverUrl: string, email: string, password: string): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError(
      `Can't reach ${serverUrl}. Check the address, and that Tailscale is connected.`,
    );
  }
  if (!resp.ok) {
    throw new AuthError(await readError(resp, `Login failed (${resp.status})`));
  }
  const tokens = (await resp.json()) as TokenPair;
  const session = sessionFromTokens(serverUrl, email.trim().toLowerCase(), tokens);
  await persist(session);
  useAuth.setState({ status: 'signedIn', session, lastServerUrl: serverUrl });
}

type SignOutListener = () => void | Promise<void>;
const signOutListeners = new Set<SignOutListener>();

/** Run something (clear caches, the backup ledger) whenever the user is signed out. */
export function onSignOut(listener: SignOutListener): () => void {
  signOutListeners.add(listener);
  return () => signOutListeners.delete(listener);
}

export async function signOut(options: { revoke?: boolean } = { revoke: true }): Promise<void> {
  const session = useAuth.getState().session;
  if (session && options.revoke) {
    // Best effort: tell the server to forget this session.
    fetch(`${session.serverUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    }).catch(() => undefined);
  }
  await persist(null);
  useAuth.setState({ status: 'signedOut', session: null });
  for (const listener of signOutListeners) {
    try {
      await listener();
    } catch {
      // A failing listener must not block logout.
    }
  }
}

let refreshInFlight: Promise<Session> | null = null;

/** Swap the refresh token for a new pair. Concurrent callers share one request. */
export function refreshSession(): Promise<Session> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const session = useAuth.getState().session;
    if (!session) throw new AuthError('Not signed in');
    let resp: Response;
    try {
      resp = await fetch(`${session.serverUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      });
    } catch {
      // Offline: keep the session so the app recovers when the network is back.
      throw new AuthError('Network unavailable');
    }
    if (resp.status === 401) {
      await signOut({ revoke: false });
      throw new AuthError('Your session has expired. Please log in again.');
    }
    if (!resp.ok) throw new AuthError(`Could not refresh the session (${resp.status})`);
    const tokens = (await resp.json()) as TokenPair;
    const next = sessionFromTokens(session.serverUrl, session.email, tokens);
    await persist(next);
    useAuth.setState({ session: next });
    return next;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** A session whose access token is good for at least the next minute or so. */
export async function getFreshSession(): Promise<Session> {
  const session = useAuth.getState().session;
  if (!session) throw new AuthError('Not signed in');
  if (session.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return session;
  return refreshSession();
}

/** Keep the access token fresh while the app is open, so image URLs keep working. */
export function startTokenKeepAlive(): () => void {
  const tick = () => {
    const { status, session } = useAuth.getState();
    if (status === 'signedIn' && session && session.accessExpiresAt - Date.now() < 2 * REFRESH_MARGIN_MS) {
      refreshSession().catch(() => undefined);
    }
  };
  const timer = setInterval(tick, 30_000);
  tick();
  return () => clearInterval(timer);
}
