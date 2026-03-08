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

    // Create the Firebase Auth user server-side — admin stays logged in on client
    const userRecord = await auth.createUser({ email, password, displayName: username });

    const appUser: AppUser = {
      uid: userRecord.uid,
      username,
      email,
      role: role ?? 'user',
    };

    await db.ref(`users/${userRecord.uid}`).set(appUser);

    return NextResponse.json({ success: true, uid: userRecord.uid, username });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
