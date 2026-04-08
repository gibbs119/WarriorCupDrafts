import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices, pushToUser } from '@/lib/fcm-admin';

// Notifies the admin when a user submits a WD replacement request.
export async function POST(req: NextRequest) {
  try {
    const { tournamentId, username, droppedPlayerName, replacementPlayerName } = await req.json();

    const { messaging, db } = getAdminServices();

    // Find the admin user
    const usersSnap = await db.ref('users').get();
    if (!usersSnap.exists()) return NextResponse.json({ ok: false });

    const users = Object.values(usersSnap.val() as Record<string, { uid: string; role: string }>);
    const admin = users.find((u) => u.role === 'admin');
    if (!admin) return NextResponse.json({ ok: false });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    await pushToUser(
      messaging, db, admin.uid,
      `🔄 WD Request from ${username}`,
      `${droppedPlayerName} → ${replacementPlayerName}. Needs your approval.`,
      `${appUrl}/admin/rosters/${tournamentId}`,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[notify-wd]', err);
    return NextResponse.json({ ok: false });
  }
}
