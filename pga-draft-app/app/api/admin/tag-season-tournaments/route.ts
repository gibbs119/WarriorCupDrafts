import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices } from '@/lib/fcm-admin';

// One-shot migration: tags tournaments that have no year field with the given year.
// Safe to call multiple times — only updates untagged records.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { year = 2026 } = body as { year?: number };

    const { db } = getAdminServices();
    const snap = await db.ref('tournaments').get();
    if (!snap.exists()) {
      return NextResponse.json({ success: true, tagged: 0, message: 'No tournaments found' });
    }

    type TRow = { id?: string; year?: number; sequence?: number; name?: string };
    const all = snap.val() as Record<string, TRow>;
    const updates: Record<string, number> = {};

    for (const [key, t] of Object.entries(all)) {
      if (t.year == null) {
        updates[`tournaments/${key}/year`] = year;
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: true, tagged: 0, message: 'All tournaments already have year tags' });
    }

    await db.ref().update(updates);

    return NextResponse.json({
      success: true,
      tagged: Object.keys(updates).length,
      year,
      message: `Tagged ${Object.keys(updates).length} tournament(s) with year ${year}`,
    });
  } catch (err) {
    console.error('[TagSeasonTournaments]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
