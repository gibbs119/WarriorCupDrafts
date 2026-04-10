'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
  signInWithPopup,
  signInAnonymously,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  updatePassword as firebaseUpdatePassword,
  verifyBeforeUpdateEmail,
  reauthenticateWithCredential,
  EmailAuthProvider,
  User as FirebaseUser,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from './firebase';
import { getUserByUid, setUser, updateUserEmail } from './db';
import type { AppUser } from './types';

const CACHE_KEY = 'pgadraft_user';

function readCache(): AppUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as AppUser) : null;
  } catch {
    return null;
  }
}

function writeCache(user: AppUser | null) {
  if (typeof window === 'undefined') return;
  if (user) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(CACHE_KEY);
  }
}

// Returned by signInWithGoogle when the user is new (no DB record yet).
// The caller should prompt username selection, then call linkGoogleAccount.
export interface GooglePendingUser {
  uid: string;
  googleEmail: string;
  displayName: string | null;
}

interface AuthContextValue {
  firebaseUser: FirebaseUser | null;
  appUser: AppUser | null;
  loading: boolean;
  isViewMode: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<{ status: 'ok' } | { status: 'new'; pending: GooglePendingUser }>;
  signInAsViewer: () => Promise<void>;
  linkGoogleAccount: (pending: GooglePendingUser, username: string) => Promise<void>;
  signOut: () => Promise<void>;
  createAccount: (email: string, password: string, username: string, role: 'admin' | 'user') => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  changeEmail: (currentPassword: string, newEmail: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  // Seed from localStorage so returning users see their data instantly
  const [appUser, setAppUserState] = useState<AppUser | null>(readCache);
  // Only show loading spinner if there's no cached data to show
  const [loading, setLoading] = useState(() => readCache() === null);
  const [isViewMode, setIsViewMode] = useState(false);

  function setAppUser(user: AppUser | null) {
    setAppUserState(user);
    writeCache(user);
  }

  // Detect view mode from URL param on mount (before auth state resolves)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('view')) {
      try { sessionStorage.setItem('viewMode', '1'); } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);

      const isView = (() => {
        try { return sessionStorage.getItem('viewMode') === '1'; } catch { return false; }
      })();

      if (fbUser?.isAnonymous) {
        // View-only mode: synthetic viewer user, NOT stored in DB or localStorage
        setIsViewMode(true);
        setAppUserState({
          uid:      fbUser.uid,
          username: 'Viewer',
          email:    '',
          role:     'viewer',
        });
        setLoading(false);
      } else if (fbUser && !fbUser.isAnonymous) {
        // Real authenticated user — clear any stale view mode flag
        try { sessionStorage.removeItem('viewMode'); } catch { /* ignore */ }
        setIsViewMode(false);
        const user = await getUserByUid(fbUser.uid);
        setAppUser(user);
        setLoading(false);
      } else {
        // No user signed in
        if (isView) {
          // View mode requested — sign in anonymously.
          // onAuthStateChanged will fire again with the anonymous user.
          setIsViewMode(true);
          signInAnonymously(auth).catch((err) => {
            console.error('[viewMode] Anonymous auth failed:', err);
            try { sessionStorage.removeItem('viewMode'); } catch { /* ignore */ }
            setIsViewMode(false);
            setAppUser(null);
            setLoading(false);
          });
          // Don't set loading=false yet — wait for next onAuthStateChanged callback
        } else {
          setAppUser(null);
          setLoading(false);
        }
      }
    });
    return unsub;
  }, []);

  async function signIn(email: string, password: string) {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const user = await getUserByUid(cred.user.uid);
    setFirebaseUser(cred.user);
    setAppUser(user);
    setLoading(false);
  }

  async function signInWithGoogle(): Promise<{ status: 'ok' } | { status: 'new'; pending: GooglePendingUser }> {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    setFirebaseUser(cred.user);

    const existing = await getUserByUid(cred.user.uid);
    if (existing) {
      setAppUser(existing);
      setLoading(false);
      return { status: 'ok' };
    }

    // First Google login — caller must ask which league member they are
    return {
      status: 'new',
      pending: {
        uid: cred.user.uid,
        googleEmail: cred.user.email ?? '',
        displayName: cred.user.displayName,
      },
    };
  }

  async function linkGoogleAccount(pending: GooglePendingUser, username: string) {
    const { getUserByUsername } = await import('./db');
    const existing = await getUserByUsername(username);
    // If they had a prior password-based account, copy their role; otherwise default to user
    const role = existing?.role ?? 'user';
    const newUser: AppUser = {
      uid: pending.uid,
      username,
      email: pending.googleEmail,
      role: role as 'admin' | 'user',
    };
    await setUser(pending.uid, newUser);
    setAppUser(newUser);
    setLoading(false);
  }

  async function signInAsViewer() {
    try {
      sessionStorage.setItem('viewMode', '1');
      await signInAnonymously(auth);
      // onAuthStateChanged fires with anonymous user → sets isViewMode + appUser viewer
    } catch (err) {
      try { sessionStorage.removeItem('viewMode'); } catch { /* ignore */ }
      throw err;
    }
  }

  async function signOut() {
    try { sessionStorage.removeItem('viewMode'); } catch { /* ignore */ }
    setIsViewMode(false);
    await firebaseSignOut(auth);
    setAppUser(null);
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error('Not signed in');
    const cred = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, cred);
    await firebaseUpdatePassword(user, newPassword);
  }

  async function changeEmail(currentPassword: string, newEmail: string) {
    const user = auth.currentUser;
    if (!user || !user.email) throw new Error('Not signed in');
    const cred = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, cred);
    // verifyBeforeUpdateEmail sends a verification link to the new address.
    // The Firebase Auth email only changes after the user clicks the link.
    // We update the DB immediately so login can use either old or new email.
    await verifyBeforeUpdateEmail(user, newEmail);
    await updateUserEmail(user.uid, newEmail);
    if (appUser) setAppUser({ ...appUser, email: newEmail });
  }

  async function createAccount(
    email: string,
    password: string,
    username: string,
    role: 'admin' | 'user'
  ) {
    const currentUser = auth.currentUser;
    const adminEmail = currentUser?.email ?? null;
    void adminEmail; // kept for reference

    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const newUser: AppUser = { uid: cred.user.uid, username, email, role };
    await setUser(cred.user.uid, newUser);
    await firebaseSignOut(auth);
  }

  return (
    <AuthContext.Provider value={{ firebaseUser, appUser, loading, isViewMode, signIn, signInWithGoogle, signInAsViewer, linkGoogleAccount, signOut, createAccount, changePassword, changeEmail }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
