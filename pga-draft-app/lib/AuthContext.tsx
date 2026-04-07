'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
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

interface AuthContextValue {
  firebaseUser: FirebaseUser | null;
  appUser: AppUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
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

  function setAppUser(user: AppUser | null) {
    setAppUserState(user);
    writeCache(user);
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      if (fbUser) {
        const user = await getUserByUid(fbUser.uid);
        setAppUser(user);
      } else {
        setAppUser(null);
      }
      setLoading(false);
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

  async function signOut() {
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
    <AuthContext.Provider value={{ firebaseUser, appUser, loading, signIn, signOut, createAccount, changePassword, changeEmail }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
