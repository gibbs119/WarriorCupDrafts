import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices, pushToUser } from '@/lib/fcm-admin';
import { fetchLeaderboardRaw, parseLeaderboard } from '@/lib/espn';

// Runs every 5 minutes during tournament hours.
// Sends push notifications to users when their drafted players tee off.
// Only notifies each user once per player per round per day.

const NOTIFY_WINDOW_BEFORE_MS = 5 * 60 * 1000;   // notify up to 5 min before tee time
const NOTIFY_WINDOW_AFTER_MS  = 2 * 60 * 1000;   // still notify up to 2 min after (cron drift)

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { messaging, db } = getAdminServices();

    // Find active tournaments
    const tournamentsSnap = await db.ref('tournaments').get();
    if (!tournamentsSnap.exists()) return NextResponse.json({ skipped: 'no tournaments' });

    const tournaments = Object.values(
      tournamentsSnap.val() as Record<string, { id: string; status: string; espnEventId: string; name: string }>
    ).filter((t) => t.status === 'active');

    if (tournaments.length === 0) return NextResponse.json({ skipped: 'no active tournaments' });

    const results: Record<string, unknown> = {};

    for (const tournament of tournaments) {
      const { id: tournamentId, espnEventId, name: tournamentName } = tournament;
      if (!espnEventId) continue;

      // Fetch live ESPN data
      const raw = await fetchLeaderboardRaw(espnEventId);
      if (!raw) {
        results[tournamentId] = 'ESPN fetch failed';
        continue;
      }

      const { players } = parseLeaderboard(raw.data as Parameters<typeof parseLeaderboard>[0]);
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      // Load draft picks to build player → [userId] map
      const draftSnap = await db.ref(`drafts/${tournamentId}/picks`).get();
      if (!draftSnap.exists()) {
        results[tournamentId] = 'no picks';
        continue;
      }

      type Pick = { userId: string; playerId: string; playerName: string };
      const picks: Pick[] = Object.values(draftSnap.val() as Record<string, Pick>);

      // Build reverse lookup: playerId → Set<userId>
      const playerOwners: Record<string, Set<string>> = {};
      for (const pick of picks) {
        if (!pick.playerId || pick.playerId === '__removed__') continue;
        if (!playerOwners[pick.playerId]) playerOwners[pick.playerId] = new Set();
        playerOwners[pick.playerId].add(pick.userId);
      }

      // Load already-notified set for today
      const notifiedSnap = await db.ref(`notifiedTeeTimes/${tournamentId}/${today}`).get();
      const alreadyNotified = new Set<string>(
        notifiedSnap.exists() ? Object.keys(notifiedSnap.val() as Record<string, unknown>) : []
      );

      let notifiedCount = 0;
      const usersSnap = await db.ref('users').get();
      const usersMap = usersSnap.exists()
        ? usersSnap.val() as Record<string, { uid: string; username: string }>
        : {};

      for (const player of Object.values(players)) {
        if (!player.teeTime) continue;
        if (alreadyNotified.has(player.id)) continue;

        const teeMs = new Date(player.teeTime).getTime();
        if (isNaN(teeMs)) continue;

        // Only notify within the window: [teeTime - 5min, teeTime + 2min]
        if (now < teeMs - NOTIFY_WINDOW_BEFORE_MS) continue;
        if (now > teeMs + NOTIFY_WINDOW_AFTER_MS) continue;

        // Player is about to tee off — find their owners
        const ownerIds = Array.from(playerOwners[player.id] ?? []);
        if (ownerIds.length === 0) continue;

        const roundLabel = player.currentRound ? `Round ${player.currentRound}` : 'Round 1';

        for (const userId of ownerIds) {
          const username = usersMap[userId]?.username ?? 'Your pick';
          await pushToUser(
            messaging, db, userId,
            `⛳ ${player.name} is teeing off!`,
            `${username}'s pick just teed off in ${roundLabel} of ${tournamentName}`,
            `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/leaderboard/${tournamentId}`,
          ).catch((e) => console.warn(`[tee-notify] push failed for ${userId}:`, e));
        }

        // Mark notified
        await db.ref(`notifiedTeeTimes/${tournamentId}/${today}/${player.id}`).set(Date.now());
        alreadyNotified.add(player.id);
        notifiedCount++;
      }

      results[tournamentId] = `notified ${notifiedCount} players`;
    }

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[tee-notify] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
