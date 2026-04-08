// ─── FCM Admin — server-side push helpers ─────────────────────────────────────
// Shared by notify-draft, draft-grades, and daily-summary routes.
// Uses Firebase Admin SDK — works even when recipients' apps are closed.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging, type Messaging }  from 'firebase-admin/messaging';
import { getDatabase, type Database }    from 'firebase-admin/database';

export function getAdminServices() {
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
  return { messaging: getMessaging(), db: getDatabase() };
}

// ─── Push to every token for one user, cleaning up stale tokens ──────────────

export async function pushToUser(
  messaging: Messaging,
  db:        Database,
  uid:       string,
  title:     string,
  body:      string,
  url:       string,
) {
  const snap = await db.ref(`users/${uid}/fcmTokens`).get();
  if (!snap.exists()) return;

  const tokens: string[] = Object.values(
    snap.val() as Record<string, { token: string }>
  ).map((v) => v.token).filter(Boolean);

  if (tokens.length === 0) return;

  const staleKeys: string[] = [];

  await Promise.allSettled(
    tokens.map(async (token) => {
      try {
        await messaging.send({
          token,
          notification: { title, body },
          webpush: {
            notification: {
              title, body,
              icon:  '/favicon.ico',
              badge: '/favicon.ico',
              tag:   'wcd-notification',
              renotify: true,
            },
            fcmOptions: { link: url },
          },
          apns: {
            payload: { aps: { alert: { title, body }, sound: 'default', badge: 1 } },
          },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          msg.includes('registration-token-not-registered') ||
          msg.includes('invalid-registration-token') ||
          msg.includes('SenderId mismatch')
        ) {
          staleKeys.push(token.slice(0, 20).replace(/[.#$/[\]]/g, '_'));
        }
      }
    })
  );

  for (const key of staleKeys) {
    await db.ref(`users/${uid}/fcmTokens/${key}`).remove().catch(() => {});
  }
}

// ─── Push to ALL registered users ─────────────────────────────────────────────

export async function pushToAllUsers(
  messaging: Messaging,
  db:        Database,
  title:     string,
  body:      string,
  url:       string,
) {
  const snap = await db.ref('users').get();
  if (!snap.exists()) return 0;

  const uids = Object.keys(snap.val() as Record<string, unknown>);
  await Promise.allSettled(
    uids.map((uid) => pushToUser(messaging, db, uid, title, body, url))
  );
  return uids.length;
}
