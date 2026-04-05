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
 * POST /api/admin/reset-password
 *
 * Body: { secret, username, newPassword }
 *   - secret: must match ADMIN_API_SECRET env var
 *   - username: the display name of the user (looked up in /users DB node)
 *   - newPassword: the new password to set (min 6 chars)
 *
 * No email is sent. No user data is touched. Only Firebase Auth password is updated.
 */
export async function POST(req: NextRequest) {
  try {
    const { secret, username, newPassword } = await req.json();

    // Guard with a shared secret so this endpoint isn't publicly exploitable
    const expectedSecret = process.env.ADMIN_API_SECRET;
    if (!expectedSecret || secret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!username || !newPassword) {
      return NextResponse.json({ error: 'Missing username or newPassword' }, { status: 400 });
    }

    if (newPassword.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
    }

    const { auth, db } = getAdminServices();

    // Find the user's UID by scanning the /users node for a matching username
    const snapshot = await db.ref('users').orderByChild('username').equalTo(username).get();
    if (!snapshot.exists()) {
      return NextResponse.json({ error: `No user found with username: ${username}` }, { status: 404 });
    }

    // There should be exactly one match
    const usersData = snapshot.val() as Record<string, { uid: string; username: string; email: string }>;
    const entries = Object.entries(usersData);
    if (entries.length === 0) {
      return NextResponse.json({ error: `No user found with username: ${username}` }, { status: 404 });
    }

    const [uid, userData] = entries[0];

    // Update only the password — leaves all other Auth fields and DB records intact
    await auth.updateUser(uid, { password: newPassword });

    return NextResponse.json({
      success: true,
      uid,
      username: userData.username,
      email: userData.email,
      message: `Password updated for ${userData.username}. All tournament data preserved.`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
