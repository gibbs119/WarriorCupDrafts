import { NextRequest, NextResponse } from 'next/server';
import { fetchLeaderboardRaw, parseLeaderboard } from '@/lib/espn';

// Temporary debug endpoint — DELETE after debugging
// Visit: /api/debug/espn?eventId=401811937

export async function GET(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId') ?? '401811937';

  const result = await fetchLeaderboardRaw(eventId);
  if (!result) {
    return NextResponse.json({ error: 'ESPN fetch failed — all endpoints returned null' });
  }

  const { players, fieldSize, cutLine } = parseLeaderboard(result.data as any);

  const raw = result.data as any;
  const competition = raw?.events?.[0]?.competitions?.[0];
  const first5raw = (competition?.competitors ?? []).slice(0, 5).map((c: any) => ({
    name: c.athlete?.displayName,
    status: c.status,
    score: c.score,
    sortOrder: c.sortOrder,
  }));

  const first5parsed = Object.values(players).slice(0, 5);

  return NextResponse.json({
    source: result.source,
    fieldSize,
    cutLine,
    parsedPlayerCount: Object.keys(players).length,
    first5raw,
    first5parsed,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
