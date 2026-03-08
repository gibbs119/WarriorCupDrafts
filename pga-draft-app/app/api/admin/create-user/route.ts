import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import type { AppUser } from '@/lib/types';

function getAdminServices() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
    });
  }
  return { auth: getAuth(), db: getDatabase() };
}

export async function POST(req: NextRequest) {
  try {
    const { email, password, username, role } = await req.json();
    if (!email || !password || !username) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const { auth, db } = getAdminServices();

    let uid: string;

    try {
      // Try to create new Auth user
      const userRecord = await auth.createUser({ email, password, displayName: username });
      uid = userRecord.uid;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('email-already-exists') || msg.includes('EMAIL_EXISTS')) {
        // Auth account already exists — just look up the UID and rebuild the DB record
        const existing = await auth.getUserByEmail(email);
        uid = existing.uid;
      } else {
        throw e;
      }
    }

    const appUser: AppUser = { uid, username, email, role: role ?? 'user' };
    await db.ref(`users/${uid}`).set(appUser);

    return NextResponse.json({ success: true, uid, username });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
