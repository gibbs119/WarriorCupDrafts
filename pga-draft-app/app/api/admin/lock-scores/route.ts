import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { fetchLeaderboardRaw, parseLeaderboard } from '@/lib/espn';
import { calculateLeaderboard } from '@/lib/scoring';
import type { DraftPick, AppUser } from '@/lib/types';

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

export async function POST(req: NextRequest) {
  try {
    const { tournamentId, lockedBy } = await req.json();
    if (!tournamentId) return NextResponse.json({ error: 'Missing tournamentId' }, { status: 400 });

    const db = getAdminDb();

    const tSnap = await db.ref(`tournaments/${tournamentId}`).get();
    if (!tSnap.exists()) return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    const t = tSnap.val();

    if (!t.espnEventId) return NextResponse.json({ error: 'No ESPN Event ID set for this tournament' }, { status: 400 });

    // Fetch from ESPN
    const raw = await fetchLeaderboardRaw(t.espnEventId);
    if (!raw) return NextResponse.json({ error: 'ESPN data unavailable — try again in a few minutes' }, { status: 503 });

    const { players: playersMap, cutLine } = parseLeaderboard(
      raw.data as Parameters<typeof parseLeaderboard>[0]
    );

    if (Object.keys(playersMap).length === 0) {
      return NextResponse.json({ error: 'ESPN returned empty player data' }, { status: 503 });
    }

    const draftSnap = await db.ref(`drafts/${tournamentId}/picks`).get();
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
    const year = new Date(lockedAt).getFullYear();

    await db.ref(`lockedScores/${tournamentId}`).set({
      tournamentId, tournamentName: t.name, year, lockedAt,
      lockedBy: lockedBy ?? 'admin-manual',
      teamScores, playerSnapshot: playersMap,
    });

    await db.ref(`results/${tournamentId}`).update({ rankedOrder: rankedUids, teamScores, lockedAt });

    await db.ref(`tournaments/${tournamentId}`).update({
      scoreLocked: true, scoreLockedAt: lockedAt, status: 'completed',
    });

    const SEQUENCE = ['players-championship','masters','pga-championship','us-open','the-open'];
    const nextIdx = SEQUENCE.indexOf(tournamentId) + 1;
    if (nextIdx < SEQUENCE.length) {
      await db.ref(`tournaments/${SEQUENCE[nextIdx]}`).update({ draftOrder: rankedUids });
    }

    return NextResponse.json({ success: true, lockedAt, teamScores, playerCount: Object.keys(playersMap).length });
  } catch (err) {
    console.error('[ManualLock]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
