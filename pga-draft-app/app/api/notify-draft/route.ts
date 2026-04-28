// POST /api/notify-draft
// Called by the client immediately after a pick is submitted.
// Sends FCM push notifications to:
//   - the player whose turn it now is ("your pick!")
//   - the player who is on deck ("you're next")

import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices, pushToUser } from '@/lib/fcm-admin';

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

    const draftSnap = await db.ref(`drafts/${tournamentId}`).get();
    if (!draftSnap.exists()) return NextResponse.json({ sent: 0 });

    const draft = draftSnap.val() as {
      snakeDraftOrder: string[];
      currentPickIndex: number;
      status: string;
    };

    if (draft.status === 'complete') {
      return NextResponse.json({ sent: 0, reason: 'draft complete' });
    }

    // snakeDraftOrder is the full pre-expanded pick sequence (length = totalPicks)
    // so order[idx] is directly the UID of the current picker — no round math needed.
    const order = draft.snakeDraftOrder ?? [];
    const idx   = draft.currentPickIndex ?? 0;
    if (order.length === 0) return NextResponse.json({ sent: 0 });

    const tourSnap = await db.ref(`tournaments/${tournamentId}`).get();
    const tourName = tourSnap.exists()
      ? ((tourSnap.val() as { shortName?: string; name?: string }).shortName ??
         (tourSnap.val() as { name?: string }).name ?? 'Draft')
      : 'Draft';

    const origin   = baseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
    const draftUrl = `${origin}/draft/${tournamentId}`;
    let sent = 0;

    const pickLabel = `Pick ${idx + 1} of ${order.length}`;

    const currentUid = order[idx];
    if (currentUid) {
      await pushToUser(messaging, db, currentUid,
        `⛳ You're on the clock! — ${tourName}`,
        `${pickLabel}. Open the draft room and make your selection.`,
        draftUrl,
      );
      sent++;
    }

    if (idx + 1 < order.length) {
      const nextUid = order[idx + 1];
      if (nextUid && nextUid !== currentUid) {
        await pushToUser(messaging, db, nextUid,
          `🔜 You're on deck! — ${tourName}`,
          `Pick ${idx + 2} of ${order.length} is yours. Start thinking.`,
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
