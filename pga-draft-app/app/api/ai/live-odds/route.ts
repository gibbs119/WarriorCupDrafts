import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices } from '@/lib/fcm-admin';
import { TOP_10_POINTS } from '@/lib/constants';

// Generates live AI win-probability odds for each fantasy team based on current
// tournament scores. Cached in Firebase; regenerates if > 25 minutes old.
// Called automatically alongside each hourly trend snapshot (Thu–Sun, 8AM–8PM).
// Also callable manually from the Odds tab (admin only).
// Uses OpenAI API (gpt-4o-mini).

export interface LiveOdds {
  generatedAt: number;
  roundLabel: string;
  analysis: string;          // 2-3 sentence overall narrative
  odds: {
    userId: string;
    username: string;
    winPct: number;          // 0–100, all must sum to 100
    trend: 'up' | 'down' | 'stable';
    insight: string;         // one punchy sentence per team
  }[];
}

// ── OpenAI API ───────────────────────────────────────────────────────────────
async function callOpenAI(prompt: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    console.error('[live-odds] OPENAI_API_KEY not set');
    return null;
  }
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.8,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[live-odds] OpenAI error:', res.status, err);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error('[live-odds] OpenAI fetch error:', e);
    return null;
  }
}

// ── Scoring helpers ───────────────────────────────────────────────────────────
const TOTAL_ROUNDS = 4;

function fantasyPts(position: number | null, status: string, cutLine: number): number {
  if (status === 'cut' || status === 'wd' || status === 'dq') return cutLine + 1;
  if (!position || position === 0) return 9999;
  return position <= 10 ? TOP_10_POINTS[position - 1] : position;
}

// Points swing if player moves from their current position to T10 (or vice versa).
// Positive = points improvement (lower score). Returns null if player is cut/wd/dq.
function top10Swing(position: number | null, status: string, cutLine: number): number | null {
  if (status !== 'active' || !position || position === 0) return null;
  const currentPts = fantasyPts(position, status, cutLine);
  const top10EdgePts = TOP_10_POINTS[9]; // -1 (position 10)
  if (position <= 10) {
    // Inside: what they'd lose by falling to T11
    const outsidePts = 11; // position 11 = 11 pts
    return outsidePts - currentPts; // positive = how much worse falling out would be
  } else {
    // Outside: what they'd gain by reaching T10
    return currentPts - top10EdgePts; // positive = how much better breaking in would be
  }
}

export async function POST(req: NextRequest) {
  try {
    const { tournamentId, force } = await req.json();
    if (!tournamentId) return NextResponse.json({ error: 'Missing tournamentId' }, { status: 400 });

    const { db: adminDb } = getAdminServices();

    // Return cached odds if < 25 minutes old (unless force=true)
    if (!force) {
      const cached = await adminDb.ref(`liveOdds/${tournamentId}`).get();
      if (cached.exists()) {
        const data = cached.val() as LiveOdds;
        if (Date.now() - data.generatedAt < 25 * 60 * 1000) {
          return NextResponse.json({ ...data, cached: true });
        }
      }
    }

    // Load all data needed
    const [draftSnap, usersSnap, playersSnap, tournamentSnap] = await Promise.all([
      adminDb.ref(`drafts/${tournamentId}`).get(),
      adminDb.ref('users').get(),
      adminDb.ref(`players/${tournamentId}`).get(),
      adminDb.ref(`tournaments/${tournamentId}`).get(),
    ]);

    if (!draftSnap.exists()) return NextResponse.json({ error: 'No draft found' }, { status: 404 });
    if (!playersSnap.exists()) return NextResponse.json({ error: 'No scores yet' }, { status: 404 });

    const draftState = draftSnap.val();
    const users = usersSnap.exists()
      ? (Object.values(usersSnap.val()) as Array<{ uid: string; username: string }>)
      : [];
    const playersMap = playersSnap.val() as Record<string, {
      position?: number; positionDisplay?: string; score?: string;
      thru?: string; status?: string; currentRound?: number; name?: string;
    }>;
    const tournament = tournamentSnap.exists() ? tournamentSnap.val() : null;
    const cutLine    = tournament?.cutLine ?? 65;
    const maxPicks   = tournament?.maxPicks ?? 5;

    // ── Round context ────────────────────────────────────────────────────────
    const currentRound = Object.values(playersMap).reduce(
      (m, p) => Math.max(m, p.currentRound ?? 1), 1
    );
    const roundLabel       = `Round ${currentRound}`;
    const roundsRemaining  = TOTAL_ROUNDS - currentRound; // rounds AFTER this one

    // ── Top-10 cutline from full field ────────────────────────────────────────
    // Find the stroke score of the player currently at exactly position 10.
    // This tells the AI what score a drafted player needs to reach to break in.
    const allActivePlayers = Object.values(playersMap).filter(
      p => p.status === 'active' && typeof p.position === 'number' && p.position > 0
    );
    const top10Player = allActivePlayers.find(p => p.position === 10);
    const top11Player = allActivePlayers.find(p => p.position === 11);
    const cutlineScore = top10Player?.score ?? top11Player?.score ?? 'unknown';

    const picks = draftState.picks ?? [];

    // ── Build enriched team summaries ─────────────────────────────────────────
    interface RichPlayer {
      name: string;
      posDisplay: string;
      position: number | null;
      score: string;
      thru: string;
      status: string;
      points: number;
      holesLeftThisRound: number;
      totalTournamentHolesLeft: number;
      scoreLocked: boolean;       // finished all rounds they'll play (final-round F or cut)
      insideTop10: boolean;
      spotsFromTop10: number;     // 0 if inside; positive = how many spots outside
      top10PtSwing: number | null; // pts gained by entering / pts lost by falling out
    }
    interface TeamEntry {
      userId: string; username: string;
      players: RichPlayer[];
      top3Score: number; rank: number;
    }

    const teams: TeamEntry[] = [];

    for (const user of users) {
      const myPicks = picks.filter((p: { userId: string }) => p.userId === user.uid);
      if (myPicks.length === 0) continue;

      const players: RichPlayer[] = myPicks.map((p: { playerName: string; playerId: string }) => {
        const pd = playersMap[p.playerId] ?? playersMap[p.playerName] ?? {};
        const position = typeof pd.position === 'number' ? pd.position : null;
        const status   = pd.status ?? 'active';
        const thru     = pd.thru ?? '-';

        let holesLeftThisRound = 18;
        if (thru === 'F') holesLeftThisRound = 0;
        else if (thru !== '-') holesLeftThisRound = Math.max(0, 18 - parseInt(thru, 10));

        // Total holes left in the entire tournament
        const totalTournamentHolesLeft =
          (status === 'cut' || status === 'wd' || status === 'dq')
            ? 0
            : holesLeftThisRound + roundsRemaining * 18;

        // Score is locked if: cut/wd/dq OR finished the final round
        const scoreLocked =
          status === 'cut' || status === 'wd' || status === 'dq' ||
          (thru === 'F' && currentRound === TOTAL_ROUNDS);

        const points        = fantasyPts(position, status, cutLine);
        const insideTop10   = position !== null && position > 0 && position <= 10;
        const spotsFromTop10 = position === null ? 999
          : insideTop10 ? 0
          : position - 10;
        const top10PtSwingVal = top10Swing(position, status, cutLine);

        return {
          name: p.playerName,
          posDisplay: pd.positionDisplay ?? '-',
          position,
          score: pd.score ?? '-',
          thru,
          status,
          points,
          holesLeftThisRound,
          totalTournamentHolesLeft,
          scoreLocked,
          insideTop10,
          spotsFromTop10,
          top10PtSwing: top10PtSwingVal,
        };
      });

      const sorted      = [...players].sort((a, b) => a.points - b.points);
      const top3        = sorted.slice(0, 3);
      const top3Score   = top3.reduce((sum, p) => sum + (p.points < 9000 ? p.points : 0), 0);

      teams.push({ userId: user.uid, username: user.username, players, top3Score, rank: 0 });
    }

    if (teams.length === 0) return NextResponse.json({ error: 'No teams found' }, { status: 404 });

    teams.sort((a, b) => a.top3Score - b.top3Score);
    teams.forEach((t, i) => { t.rank = i + 1; });

    const hasRealScores = teams.some(t => t.players.some(p => p.points < 9000));
    if (!hasRealScores) {
      return NextResponse.json({ error: 'No live scores yet' }, { status: 404 });
    }

    const totalTeams     = teams.length;
    const tournamentName = tournament?.name ?? tournamentId;

    // ── Format each player line with full context ────────────────────────────
    const teamsBlock = teams.map((t) => {
      const scoreStr = t.top3Score > 0 ? `+${t.top3Score}` : `${t.top3Score}`;

      const playerLines = t.players.map((p) => {
        if (p.status === 'cut' || p.status === 'wd' || p.status === 'dq') {
          return `    ${p.name}: [${p.status.toUpperCase()}] Score ${p.score} — SCORE LOCKED, Pts: +${p.points}`;
        }
        if (p.points >= 9000) {
          return `    ${p.name}: NOT YET STARTED — TotalHolesLeft ${p.totalTournamentHolesLeft}`;
        }

        const lockTag   = p.scoreLocked ? ' ★LOCKED' : '';
        const top10Tag  = p.insideTop10
          ? `INSIDE TOP-10 at ${p.posDisplay} (${p.top10PtSwing !== null ? `${p.top10PtSwing}pt cliff to T11` : ''})`
          : `outside top-10 by ${p.spotsFromTop10} spots (${p.top10PtSwing !== null ? `entering top-10 = ${p.top10PtSwing}pt swing` : ''})`;
        const pts = p.points <= 0 ? `${p.points}` : `+${p.points}`;

        return `    ${p.name}: ${p.posDisplay}, Score ${p.score}, Thru ${p.thru}${lockTag}, TotalHolesLeft ${p.totalTournamentHolesLeft}, Pts ${pts} — ${top10Tag}`;
      }).join('\n');

      return `#${t.rank} ${t.username} (Team Score: ${scoreStr}):\n${playerLines}`;
    }).join('\n\n');

    // ── Prompt ───────────────────────────────────────────────────────────────
    const prompt = `You are a live fantasy golf odds analyst for ${tournamentName}, a private ${totalTeams}-person draft league.

=== SCORING SYSTEM ===
Best ${maxPicks > 3 ? '3 of ' + maxPicks : '3'} drafted players count toward team score (lowest = best).
Top-10 bonuses: ${TOP_10_POINTS.map((p, i) => `T${i + 1}=${p}`).join(', ')}.
Positions 11+: points = position number (T15 = +15pts).
Cut/WD/DQ: ${cutLine + 1} pts (locked, cannot improve).
★LOCKED = score cannot change (finished or eliminated).

CRITICAL: The T10/T11 boundary is the most important threshold. Moving from T11→T10 is a +12pt swing (from +11 to -1). Players on this bubble can swing a team's score dramatically. Players deeper in the field (T25+) with few holes left are essentially locked at their current points.

=== TOURNAMENT CONTEXT ===
Currently: ${roundLabel} of ${TOTAL_ROUNDS}. Rounds remaining after this: ${roundsRemaining}.
Top-10 cutline stroke score: ${cutlineScore} (what a player needs to score to reach T10).
Volatility guide: with 18 holes left, a hot player realistically moves ±3–6 spots. With 5 holes left, ±1–2 spots is realistic. A player T25+ with <9 holes left has near-zero chance of breaking into top 10.

=== LIVE STANDINGS ===
${teamsBlock}

=== YOUR TASK ===
Assign win probabilities that reflect:
1. Current team score gap (the most important factor if large)
2. Top-10 bubble risk/upside for each drafted player — check the "entering top-10 = Xpt swing" and "cliff to T11" tags carefully
3. Score volatility: ★LOCKED players cannot change; players with 30+ total holes left have real upside/downside
4. Whether a player "not yet started" is a wildcard that could swing a team significantly
5. If the tournament is basically decided (leader has big cushion + most scores locked), compress odds accordingly

Respond ONLY with valid JSON — no markdown, no backticks:
{
  "analysis": "2-3 sentence punchy narrative of the fantasy race right now",
  "odds": [
    {
      "username": "...",
      "winPct": 35,
      "trend": "up",
      "insight": "One sharp sentence referencing specific players/positions driving this team's odds"
    }
  ]
}

Rules:
- All winPct values MUST sum to exactly 100
- trend: "up" if team improved this round, "down" if falling back, "stable" if holding
- It's OK (and correct) to give one team 60%+ if the gap is large with few holes left
- Reference specific player names and positions in insights — be concrete, not generic`;

    const text = await callOpenAI(prompt);
    if (!text) {
      return NextResponse.json({
        error: 'AI generation failed — check OPENAI_API_KEY env variable',
      }, { status: 500 });
    }

    let parsed: {
      analysis: string;
      odds: Array<{ username: string; winPct: number; trend: string; insight: string }>;
    };
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error('[live-odds] JSON parse failed:', text);
      return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 500 });
    }

    // Merge userIds from username match
    const oddsWithIds = parsed.odds.map((o) => {
      const team = teams.find((t) => t.username === o.username);
      return {
        userId:  team?.userId ?? o.username,
        username: o.username,
        winPct:  o.winPct,
        trend:   (o.trend as 'up' | 'down' | 'stable') ?? 'stable',
        insight: o.insight,
      };
    });

    const now = Date.now();

    const result: LiveOdds = {
      generatedAt: now,
      roundLabel,  // server-computed — authoritative
      analysis:    parsed.analysis,
      odds:        oddsWithIds,
    };

    // Save current odds + hourly snapshot for Odds Trend graph
    const tzOffset  = -4;
    const nowLocal  = new Date(now + tzOffset * 60 * 60 * 1000);
    const hourKey   = new Date(now).toISOString().slice(0, 13);
    const DAYS      = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow       = nowLocal.getUTCDay();
    const h         = nowLocal.getUTCHours() % 12 || 12;
    const ampm      = nowLocal.getUTCHours() < 12 ? 'AM' : 'PM';
    const hourLabel = `${DAYS[dow]} ${h}${ampm}`;
    const oddsSnap  = {
      timestamp: now,
      hour:      hourLabel,
      odds:      Object.fromEntries(oddsWithIds.map(o => [o.userId, o.winPct])),
    };

    await Promise.all([
      adminDb.ref(`liveOdds/${tournamentId}`).set(result),
      adminDb.ref(`oddsSnapshots/${tournamentId}/${hourKey}`).set(oddsSnap),
    ]);

    return NextResponse.json({ ...result, cached: false });
  } catch (err) {
    console.error('[live-odds]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const tournamentId = req.nextUrl.searchParams.get('tournamentId');
  if (!tournamentId) return NextResponse.json({ error: 'Missing tournamentId' }, { status: 400 });

  const { db: adminDb } = getAdminServices();
  const snap = await adminDb.ref(`liveOdds/${tournamentId}`).get();
  if (!snap.exists()) return NextResponse.json({ odds: null });

  return NextResponse.json({ ...snap.val(), cached: true });
}
