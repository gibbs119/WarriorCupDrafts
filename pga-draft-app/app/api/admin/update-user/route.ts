import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';

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

/**
 * POST /api/admin/update-user
 * Body: { uid, email?, password? }
 * Updates Firebase Auth (and DB email) via Admin SDK — no re-auth required.
 */
export async function POST(req: NextRequest) {
  try {
    const { uid, email, password } = await req.json();

    if (!uid) {
      return NextResponse.json({ error: 'uid is required' }, { status: 400 });
    }
    if (!email && !password) {
      return NextResponse.json({ error: 'Provide email or password to update' }, { status: 400 });
    }
    if (password && password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
    }

    const { auth, db } = getAdminServices();

    const updates: { email?: string; password?: string } = {};
    if (email)    updates.email    = email;
    if (password) updates.password = password;

    await auth.updateUser(uid, updates);

    // Keep DB email in sync
    if (email) {
      await db.ref(`users/${uid}/email`).set(email);
    }

    return NextResponse.json({ success: true, uid, updated: Object.keys(updates) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
