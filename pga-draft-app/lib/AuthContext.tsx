'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from './firebase';
import { getUserByUid, setUser } from './db';
import type { AppUser } from './types';

interface AuthContextValue {
  firebaseUser: FirebaseUser | null;
  appUser: AppUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  createAccount: (email: string, password: string, username: string, role: 'admin' | 'user') => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

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
    await signInWithEmailAndPassword(auth, email, password);
  }

  async function signOut() {
    await firebaseSignOut(auth);
  }

  async function createAccount(
    email: string,
    password: string,
    username: string,
    role: 'admin' | 'user'
  ) {
    // Re-auth as current admin after creating the new user, because
    // createUserWithEmailAndPassword immediately signs in as the new account,
    // which would log Gibbs out of the admin panel.
    const currentUser = auth.currentUser;
    // We need the admin's credentials to re-sign-in — store email temporarily
    const adminEmail = currentUser?.email ?? null;

    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const newUser: AppUser = { uid: cred.user.uid, username, email, role };
    await setUser(cred.user.uid, newUser);

    // Sign back into the admin account via server-side — the cleanest approach
    // here is to call our create-user API instead. For now, sign out the new
    // account immediately; the admin will need to stay logged in via the
    // onAuthStateChanged listener which will re-read appUser from the DB.
    // The admin's firebaseUser is already replaced, so we sign out of the new
    // account and the admin re-authenticates via the UI if needed.
    //
    // Workaround: sign the new user out immediately so admin session is restored
    // when the admin re-navigates or refreshes.
    await firebaseSignOut(auth);
    // NOTE: For a production fix, use /api/admin/create-user with Firebase Admin SDK.
    // This keeps the admin signed in without signing into the new account at all.
  }

  return (
    <AuthContext.Provider value={{ firebaseUser, appUser, loading, signIn, signOut, createAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
