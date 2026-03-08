import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { fetchLeaderboardRaw, parseLeaderboard } from '@/lib/espn';
import { calculateLeaderboard } from '@/lib/scoring';
import type { DraftPick, AppUser } from '@/lib/types';

// ─── Firebase Admin ──────────────────────────────────────────────────────────
function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_ADMIN_PROJECT_ID!,
        clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL!,
        privateKey:  process.env.FIREBASE_ADMIN_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
    });
  }
  return getDatabase();
}

// ─── Schedule: "0 0 * * 2"  = every Tuesday 00:00 UTC
//              = Monday 8:00 PM EDT (UTC-4, used all 5 tournament weeks)
//              = Monday 8:00 PM EST (UTC-5) would be 01:00 UTC Tue — close enough
//     The cron checks for any active+draftComplete tournament and locks it.
//     Safe to re-run — already-locked tournaments are skipped. ────────────────

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const results: { tournament: string; status: string; message: string }[] = [];

  try {
    const snap = await db.ref('tournaments').get();
    if (!snap.exists()) return NextResponse.json({ message: 'No tournaments' });

    const allTournaments = Object.values(snap.val()) as {
      id: string; name: string; status: string; espnEventId: string;
      cutLine: number; draftComplete: boolean; scoreLocked?: boolean;
    }[];

    const tolock = allTournaments.filter(
      (t) => (t.status === 'active' || t.status === 'completed') && t.draftComplete && !t.scoreLocked
    );

    if (tolock.length === 0) {
      return NextResponse.json({ success: true, message: 'No tournaments need locking', results: [] });
    }

    for (const t of tolock) {
      try {
        const raw = await fetchLeaderboardRaw(t.espnEventId);
        if (!raw) {
          results.push({ tournament: t.name, status: 'skipped', message: 'ESPN unavailable' });
          continue;
        }

        const { players: playersMap, cutLine } = parseLeaderboard(
          raw.data as Parameters<typeof parseLeaderboard>[0]
        );

        if (Object.keys(playersMap).length === 0) {
          results.push({ tournament: t.name, status: 'skipped', message: 'Empty ESPN data' });
          continue;
        }

        const draftSnap = await db.ref(`drafts/${t.id}/picks`).get();
        const picks: DraftPick[] = draftSnap.exists() ? draftSnap.val() : [];

        const userSnap = await db.ref('users').get();
        const users: AppUser[] = userSnap.exists() ? Object.values(userSnap.val()) : [];

        const userPicksMap: Record<string, { username: string; picks: DraftPick[] }> = {};
        for (const user of users) {
          const up = picks.filter((p) => p.userId === user.uid);
          if (up.length > 0) userPicksMap[user.uid] = { username: user.username, picks: up };
        }

        const teamScores = calculateLeaderboard(userPicksMap, playersMap, cutLine ?? t.cutLine ?? 65);
        const rankedUids = teamScores.map((s) => s.userId);
        const lockedAt = new Date().toISOString();

        // Atomic writes
        await db.ref(`lockedScores/${t.id}`).set({
          tournamentId: t.id,
          tournamentName: t.name,
          year: new Date(lockedAt).getFullYear(),
          lockedAt,
          lockedBy: 'cron-monday-8pm',
          teamScores,
          playerSnapshot: playersMap,
        });

        await db.ref(`results/${t.id}`).update({ rankedOrder: rankedUids, teamScores, lockedAt });

        await db.ref(`tournaments/${t.id}`).update({
          scoreLocked: true,
          scoreLockedAt: lockedAt,
          status: 'completed',
        });

        // Propagate standings to next tournament's draft order
        const SEQUENCE = ['players-championship','masters','pga-championship','us-open','the-open'];
        const nextIdx = SEQUENCE.indexOf(t.id) + 1;
        if (nextIdx < SEQUENCE.length) {
          await db.ref(`tournaments/${SEQUENCE[nextIdx]}`).update({ draftOrder: rankedUids });
        }

        results.push({ tournament: t.name, status: 'locked', message: `${teamScores.length} teams @ ${lockedAt}` });
      } catch (err) {
        results.push({ tournament: t.name, status: 'error', message: String(err) });
      }
    }

    return NextResponse.json({ success: true, locked: results.filter(r => r.status === 'locked').length, results });
  } catch (err) {
    console.error('[CronLock]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
