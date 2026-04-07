// POST /api/notify-draft
// Called by the client immediately after a pick is submitted.
// Sends FCM push notifications to:
//   - the player whose turn it now is ("your pick!")
//   - the player who is on deck ("you're next")
//
// Uses Firebase Admin SDK — works even when recipients' apps are closed.

import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging }                from 'firebase-admin/messaging';
import { getDatabase }                 from 'firebase-admin/database';

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
  return { messaging: getMessaging(), db: getDatabase() };
}

// ─── Snake-order helper (mirrors lib/scoring.ts logic) ───────────────────────
function getPickerAtIndex(order: string[], index: number): string {
  const n     = order.length;
  const round = Math.floor(index / n);
  const pos   = index % n;
  return round % 2 === 0 ? order[pos] : order[n - 1 - pos];
}

// ─── Send a multicast push to all tokens for a user ──────────────────────────
async function pushToUser(
  messaging: ReturnType<typeof getMessaging>,
  db:        ReturnType<typeof getDatabase>,
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

  // Stale / invalid tokens returned by FCM — remove them from the DB
  const staleKeys: string[] = [];

  await Promise.allSettled(
    tokens.map(async (token) => {
      try {
        await messaging.send({
          token,
          notification: { title, body },
          webpush: {
            notification: {
              title,
              body,
              icon:  '/favicon.ico',
              badge: '/favicon.ico',
              tag:   'draft-notification',
              renotify: true,
              requireInteraction: false,
            },
            fcmOptions: { link: url },
          },
          // iOS APNs config (needed for Safari/PWA on iOS)
          apns: {
            payload: {
              aps: {
                alert: { title, body },
                sound: 'default',
                badge: 1,
              },
            },
          },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // Mark invalid/expired tokens for removal
        if (msg.includes('registration-token-not-registered') ||
            msg.includes('invalid-registration-token') ||
            msg.includes('SenderId mismatch')) {
          const key = token.slice(0, 20).replace(/[.#$/[\]]/g, '_');
          staleKeys.push(key);
        }
      }
    })
  );

  // Clean up stale tokens
  for (const key of staleKeys) {
    await db.ref(`users/${uid}/fcmTokens/${key}`).remove().catch(() => {});
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { tournamentId, baseUrl } = await req.json() as {
      tournamentId: string;
      baseUrl?: string;
    };

    if (!tournamentId) {
      return NextResponse.json({ error: 'tournamentId required' }, { status: 400 });
    }

    const { messaging, db } = getAdminServices();

    // Load current draft state
    const draftSnap = await db.ref(`drafts/${tournamentId}`).get();
    if (!draftSnap.exists()) {
      return NextResponse.json({ sent: 0 });
    }

    const draft = draftSnap.val() as {
      snakeDraftOrder: string[];
      currentPickIndex: number;
      status: string;
    };

    if (draft.status === 'complete') {
      return NextResponse.json({ sent: 0, reason: 'draft complete' });
    }

    const order = draft.snakeDraftOrder ?? [];
    const idx   = draft.currentPickIndex ?? 0;
    if (order.length === 0) return NextResponse.json({ sent: 0 });

    const tourSnap = await db.ref(`tournaments/${tournamentId}`).get();
    const tourName = tourSnap.exists()
      ? ((tourSnap.val() as { shortName?: string; name?: string }).shortName ??
         (tourSnap.val() as { name?: string }).name ?? 'Draft')
      : 'Draft';

    const origin = baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
    const draftUrl = `${origin}/draft/${tournamentId}`;

    let sent = 0;

    // ── Notify current picker ─────────────────────────────────────────────────
    const currentUid = getPickerAtIndex(order, idx);
    await pushToUser(
      messaging, db, currentUid,
      `⛳ It's your pick! — ${tourName}`,
      'Head to the Warrior Cup draft room and make your selection.',
      draftUrl,
    );
    sent++;

    // ── Notify on-deck picker (if different person) ───────────────────────────
    if (idx + 1 < order.length) {
      const nextUid = getPickerAtIndex(order, idx + 1);
      if (nextUid !== currentUid) {
        await pushToUser(
          messaging, db, nextUid,
          `🔜 You're on deck! — ${tourName}`,
          'One more pick before it\'s your turn — start thinking.',
          draftUrl,
        );
        sent++;
      }
    }

    return NextResponse.json({ sent });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[notify-draft]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
