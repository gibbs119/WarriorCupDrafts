// POST /api/notify-draft
// Called by the client immediately after a pick is submitted.
// Sends FCM push notifications to:
//   - the player whose turn it now is ("your pick!")
//   - the player who is on deck ("you're next")

import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices, pushToUser } from '@/lib/fcm-admin';

// ─── Snake-order helper (mirrors lib/scoring.ts logic) ───────────────────────
function getPickerAtIndex(order: string[], index: number): string {
  const n     = order.length;
  const round = Math.floor(index / n);
  const pos   = index % n;
  return round % 2 === 0 ? order[pos] : order[n - 1 - pos];
}

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

    const currentUid = getPickerAtIndex(order, idx);
    await pushToUser(messaging, db, currentUid,
      `⛳ It's your pick! — ${tourName}`,
      'Head to the Warrior Cup draft room and make your selection.',
      draftUrl,
    );
    sent++;

    if (idx + 1 < order.length) {
      const nextUid = getPickerAtIndex(order, idx + 1);
      if (nextUid !== currentUid) {
        await pushToUser(messaging, db, nextUid,
          `🔜 You're on deck! — ${tourName}`,
          "One more pick before it's your turn — start thinking.",
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
