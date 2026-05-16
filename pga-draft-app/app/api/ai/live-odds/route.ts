import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices } from '@/lib/fcm-admin';
import { TOP_10_POINTS } from '@/lib/constants';
import { fetchLeaderboardRaw, parseLeaderboard } from '@/lib/espn';

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
        temperature: 0.3,
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

// Parse a stroke score string ("E", "-5", "+2", "-3") to an integer.
function parseStrokeScore(score: string | undefined): number | null {
  if (!score || score === '-' || score === 'N/A' || score === 'unknown') return null;
  if (score === 'E') return 0;
  const n = parseInt(score, 10);
  return isNaN(n) ? null : n;
}

// Pre-compute the realistic maximum point improvement for a single player.
// Returns the expected improvement (positive = score gets lower/better).
// Key insight: a player far BELOW the cut line will actually improve when cut
// (e.g. T83 → cutLine+1 = 66), so that "free improvement" is included.
function computeRealisticSwing(
  position: number | null,
  status: string,
  scoreLocked: boolean,
  spotsFromTop10: number,
  insideTop10: boolean,
  top10PtSwing: number | null,
  totalHolesLeft: number,
  cutLine: number,
  cutHasBeenMade: boolean,
): number {
  if (scoreLocked || status === 'cut' || status === 'wd' || status === 'dq') return 0;
  // Players below the cut line will be cut and locked — no T10 upside, handled in realisticBestScore
  if (!cutHasBeenMade && position !== null && position > cutLine) return 0;

  if (position === null) return Math.round((cutLine + 1) * 0.04); // small wildcard for not-started

  const holesWeight =
    totalHolesLeft >= 54 ? 1.00 :
    totalHolesLeft >= 36 ? 0.85 :
    totalHolesLeft >= 18 ? 0.55 :
    totalHolesLeft >= 9  ? 0.20 : 0.04;

  if (insideTop10) {
    const ptsToT1 = Math.abs(TOP_10_POINTS[0] - (TOP_10_POINTS[position! - 1] ?? 0));
    return Math.round(ptsToT1 * holesWeight * 0.20);
  }

  if (top10PtSwing === null) return 0;

  const posWeight =
    spotsFromTop10 <= 3  ? 0.70 :
    spotsFromTop10 <= 6  ? 0.45 :
    spotsFromTop10 <= 12 ? 0.18 :
    spotsFromTop10 <= 25 ? 0.06 :
    spotsFromTop10 <= 50 ? 0.02 : 0.003;

  return Math.max(0, Math.round(top10PtSwing * holesWeight * posWeight));
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

    const draftState = draftSnap.val();
    const users = usersSnap.exists()
      ? (Object.values(usersSnap.val()) as Array<{ uid: string; username: string }>)
      : [];
    const tournament = tournamentSnap.exists() ? tournamentSnap.val() : null;
    const cutLine    = tournament?.cutLine ?? 65;
    const maxPicks   = tournament?.maxPicks ?? 5;

    // Fetch fresh ESPN scores to avoid stale Firebase cache causing wrong round detection.
    // Firebase player data can persist from a prior completed tournament (e.g. all R4 scores).
    type PlayerEntry = {
      position?: number; positionDisplay?: string; score?: string;
      thru?: string; status?: string; currentRound?: number; name?: string;
    };
    let playersMap: Record<string, PlayerEntry> = {};
    const espnEventId = tournament?.espnEventId;
    if (espnEventId) {
      try {
        const espnResult = await fetchLeaderboardRaw(espnEventId);
        if (espnResult) {
          const { players: espnPlayers } = parseLeaderboard(espnResult.data as never);
          if (Object.keys(espnPlayers).length > 0) {
            playersMap = espnPlayers as Record<string, PlayerEntry>;
          }
        }
      } catch (e) {
        console.warn('[live-odds] ESPN fetch failed, falling back to Firebase:', e);
      }
    }
    // Fall back to Firebase if ESPN fetch yielded nothing
    if (Object.keys(playersMap).length === 0) {
      if (!playersSnap.exists()) return NextResponse.json({ error: 'No scores yet' }, { status: 404 });
      playersMap = playersSnap.val() as Record<string, PlayerEntry>;
    }

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
    const cutlineScore   = top10Player?.score ?? top11Player?.score ?? 'unknown';
    const t10StrokeScore = parseStrokeScore(cutlineScore);
    const cutHasBeenMade = Object.values(playersMap).some(p => p.status === 'cut');

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
      strokesFromT10: number | null;  // negative = strokes AHEAD of T10, positive = strokes needed
      currentRoundScore: string | null;  // this round's score (e.g. "-3"), null if not available
      realisticSwing: number;  // max realistic point improvement (server-computed, not AI guess)
    }
    interface TeamEntry {
      userId: string; username: string;
      players: RichPlayer[];
      top3Score: number; rank: number;
      countingNames: Set<string>;
      bestBench: RichPlayer | null;
      gapToCount: number | null;
      realisticBestScore: number;  // best-case team score given holes remaining
      canReallyWin: boolean;       // false if realisticBestScore > leader's current score
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

        const totalTournamentHolesLeft =
          (status === 'cut' || status === 'wd' || status === 'dq')
            ? 0
            : holesLeftThisRound + roundsRemaining * 18;

        const scoreLocked =
          status === 'cut' || status === 'wd' || status === 'dq' ||
          (thru === 'F' && currentRound === TOTAL_ROUNDS);

        const points        = fantasyPts(position, status, cutLine);
        const insideTop10   = position !== null && position > 0 && position <= 10;
        const spotsFromTop10 = position === null ? 999
          : insideTop10 ? 0
          : position - 10;
        const top10PtSwingVal = top10Swing(position, status, cutLine);

        // Stroke gap to T10 bubble
        const playerStrokes = parseStrokeScore(pd.score ?? '-');
        const strokesFromT10 = (t10StrokeScore !== null && playerStrokes !== null)
          ? playerStrokes - t10StrokeScore
          : null;

        // Round scores array from ESPN (index = round - 1)
        const roundScoresArr = (pd as { roundScores?: (string | null)[] }).roundScores;
        const currentRoundScore = roundScoresArr?.[currentRound - 1] ?? null;

        const realisticSwing = computeRealisticSwing(
          position, status, scoreLocked,
          spotsFromTop10, insideTop10, top10PtSwingVal,
          totalTournamentHolesLeft, cutLine, cutHasBeenMade,
        );

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
          strokesFromT10,
          currentRoundScore,
          realisticSwing,
        };
      });

      const sorted    = [...players].sort((a, b) => a.points - b.points);
      const top3      = sorted.slice(0, 3);
      const bench     = sorted.slice(3);
      const top3Score = top3.reduce((sum, p) => sum + (p.points < 9000 ? p.points : 0), 0);

      const countingNames = new Set(top3.map(p => p.name));
      const worstCounting = top3[top3.length - 1] ?? null;
      const bestBench = bench.find(p =>
        p.status !== 'cut' && p.status !== 'wd' && p.status !== 'dq' && p.points < 9000
      ) ?? null;
      const gapToCount = (bestBench && worstCounting)
        ? bestBench.points - worstCounting.points
        : null;

      // Best-case team score: for each counting player subtract their realistic swing.
      // Cut/WD/DQ and below-cut players lock at cutLine+1 — no further improvement possible.
      // Unstarted counting players get a conservative T20 = 20pts assumption.
      const realisticBestScore = top3.reduce((sum, p) => {
        if (p.points >= 9000) return sum + 20; // not yet started → conservative T20
        if (p.status === 'cut' || p.status === 'wd' || p.status === 'dq') return sum + (cutLine + 1);
        if (!cutHasBeenMade && p.position !== null && p.position > cutLine) return sum + (cutLine + 1);
        return sum + Math.max(TOP_10_POINTS[0], p.points - p.realisticSwing);
      }, 0);

      teams.push({
        userId: user.uid, username: user.username, players, top3Score, rank: 0,
        countingNames, bestBench, gapToCount,
        realisticBestScore, canReallyWin: true, // canReallyWin set after ranking
      });
    }

    if (teams.length === 0) return NextResponse.json({ error: 'No teams found' }, { status: 404 });

    teams.sort((a, b) => a.top3Score - b.top3Score);
    teams.forEach((t, i) => {
      t.rank = i + 1;
      // A team can only win if their realistic best score beats the leader's CURRENT score.
      // If they can't beat the leader even in the best case, they cannot win.
      t.canReallyWin = i === 0 || t.realisticBestScore <= teams[0].top3Score;
    });

    const hasRealScores = teams.some(t => t.players.some(p => p.points < 9000));
    if (!hasRealScores) {
      return NextResponse.json({ error: 'No live scores yet' }, { status: 404 });
    }

    const totalTeams     = teams.length;
    const tournamentName = tournament?.name ?? tournamentId;

    // ── Format each player line with full context ────────────────────────────
    const teamsBlock = teams.map((t, idx) => {
      const scoreStr = t.top3Score > 0 ? `+${t.top3Score}` : `${t.top3Score}`;
      const teamAbove = idx > 0 ? teams[idx - 1] : null;
      const gapToNext = teamAbove ? t.top3Score - teamAbove.top3Score : null;

      const playerLines = t.players.map((p) => {
        const role = t.countingNames.has(p.name) ? 'COUNTING' : 'bench';

        if (p.status === 'cut' || p.status === 'wd' || p.status === 'dq') {
          return `    [${role}] ${p.name}: [${p.status.toUpperCase()}] Pts +${p.points} LOCKED`;
        }
        if (p.points >= 9000) {
          return `    [${role}] ${p.name}: NOT STARTED — ${p.totalTournamentHolesLeft} holes left`;
        }

        const lockTag = p.scoreLocked ? ' ★LOCKED' : '';

        const strokeCtx = p.strokesFromT10 !== null && cutlineScore !== 'unknown'
          ? p.strokesFromT10 < 0
            ? ` (${Math.abs(p.strokesFromT10)} strokes CLEAR of T10 bubble @ ${cutlineScore})`
            : p.strokesFromT10 === 0
            ? ` (right on T10 bubble @ ${cutlineScore})`
            : ` (${p.strokesFromT10} strokes FROM T10 bubble @ ${cutlineScore})`
          : '';

        const roundScorePart = p.currentRoundScore && p.currentRoundScore !== '-'
          ? `, R${currentRound}score: ${p.currentRoundScore}`
          : '';

        const top10Tag = p.insideTop10
          ? `INSIDE TOP-10 at ${p.posDisplay} (${p.top10PtSwing !== null ? `${p.top10PtSwing}pt cliff to T11` : ''})`
          : `outside T10 by ${p.spotsFromTop10} spots (${p.top10PtSwing !== null ? `entering T10 = ${p.top10PtSwing}pt swing` : ''})`;
        const pts = p.points <= 0 ? `${p.points}` : `+${p.points}`;

        return `    [${role}] ${p.name}: ${p.posDisplay}, Score ${p.score}${strokeCtx}${roundScorePart}${lockTag}, HolesLeft ${p.totalTournamentHolesLeft}, Pts ${pts} — ${top10Tag}`;
      }).join('\n');

      const leaderScore = teams[0].top3Score;
      const ceilingStr  = t.realisticBestScore <= 0 ? `${t.realisticBestScore}` : `+${t.realisticBestScore}`;
      const leaderStr   = leaderScore <= 0 ? `${leaderScore}` : `+${leaderScore}`;
      const ceilingLine = t.rank === 1
        ? `\n  LEADING — realistic floor: ${ceilingStr}`
        : t.canReallyWin
        ? `\n  REALISTIC CEILING: ${ceilingStr} — CAN close gap on leader (${leaderStr})`
        : `\n  REALISTIC CEILING: ${ceilingStr} — CANNOT WIN (ceiling worse than leader @ ${leaderStr}) → MAX 2%`;

      const benchLine = (t.bestBench && t.gapToCount !== null && t.gapToCount > 0)
        ? `\n  BENCH UPSIDE: ${t.bestBench.name} (${t.bestBench.posDisplay}, Pts ${t.bestBench.points > 0 ? '+' : ''}${t.bestBench.points}) needs ${t.gapToCount}pt improvement to enter counting (${t.bestBench.totalTournamentHolesLeft} holes left)`
        : '';

      const overtakeLine = gapToNext !== null && gapToNext > 0
        ? `\n  OVERTAKE: Need ${gapToNext}pt net swing to pass #${t.rank - 1} (${teamAbove!.username})`
        : '';

      return `#${t.rank} ${t.username} (Team Score: ${scoreStr}):${ceilingLine}${overtakeLine}${benchLine}\n${playerLines}`;
    }).join('\n\n');

    // ── Prompt ───────────────────────────────────────────────────────────────
    const prompt = `You are a live fantasy golf odds analyst for ${tournamentName}, a private ${totalTeams}-person draft league.

=== SCORING SYSTEM ===
Best ${maxPicks > 3 ? '3 of ' + maxPicks : '3'} drafted players count toward team score (lowest = best).
Top-10 bonuses: ${TOP_10_POINTS.map((p, i) => `T${i + 1}=${p}`).join(', ')}.
Positions 11+: points = position number (T15 = +15pts).
Cut/WD/DQ: ${cutLine + 1} pts (locked, cannot improve).
★LOCKED = score cannot change (finished or eliminated).
[COUNTING] = one of the 3 players counting toward team score. [bench] = not currently counting.

CRITICAL THRESHOLDS:
- T10/T11 boundary: Moving T11→T10 is a +12pt swing (+11 to -1). This is the most impactful move.
- T1/T2 boundary: Moving T2→T1 is a +10pt swing (-15 to -25). The leader gap matters at the top.
- "strokes FROM T10 bubble" tells you exactly how far a player is from the T10 bonus zone.
- "strokes CLEAR of T10 bubble" means they're safely inside — but can still fall out.

BENCH UPSIDE: If a [bench] player improves enough, they displace the worst [COUNTING] player.
OVERTAKE: The exact net swing needed for a team to move up one place in the standings.

=== TOURNAMENT CONTEXT ===
Currently: ${roundLabel} of ${TOTAL_ROUNDS}. Rounds remaining after this: ${roundsRemaining}.
Top-10 cutline stroke score: ${cutlineScore}.
Volatility guide: 18 holes left → realistic ±3–6 spots. 5 holes left → ±1–2 spots. T25+ with <9 holes left → near-zero chance of T10.

=== LIVE STANDINGS ===
${teamsBlock}

=== YOUR TASK ===
Assign win probabilities. The REALISTIC CEILING lines are server-computed math — trust them over your intuition.

MANDATORY RULES (enforce these before writing a single number):
1. Any team marked "CANNOT WIN" MUST receive ≤2% — their best-case score mathematically cannot beat the leader. Do NOT assign more because their players look strong.
2. Teams marked "CAN close gap" get odds proportional to how close their ceiling is to the leader.
3. The leader gets the remainder after all others are assigned (likely 50%+ if their lead is large).
4. ★LOCKED scores are fixed — do not factor them into upside.
5. R${currentRound}score reveals this round's momentum — a player on a hot round has more upside.
6. BENCH UPSIDE: a bench player with low gapToCount and many holes left is a real wildcard.

Respond ONLY with valid JSON — no markdown, no backticks:
{
  "analysis": "2-3 sentence punchy narrative referencing the realistic ceiling math and actual score gaps",
  "odds": [
    {
      "username": "...",
      "winPct": 35,
      "trend": "up",
      "insight": "One sharp sentence with the specific pt gap and ceiling — e.g. 'ceiling +45 can't touch leader +11'"
    }
  ]
}

Rules:
- All winPct values MUST sum to exactly 100
- CANNOT WIN teams: max 2% each — redistribute remainder to teams that CAN win
- trend: "up" if improved this round vs start, "down" if falling, "stable" if holding
- Be concrete: name players, cite the ceiling score, reference the overtake gap`;

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

  // ?history=true — return all hourly odds snapshots for the Trend chart
  if (req.nextUrl.searchParams.get('history') === 'true') {
    const snap = await adminDb.ref(`oddsSnapshots/${tournamentId}`).get();
    if (!snap.exists()) return NextResponse.json({ snapshots: [] });
    const raw = snap.val() as Record<string, { timestamp: number; hour: string; odds: Record<string, number> }>;
    const snapshots = Object.values(raw).sort((a, b) => a.timestamp - b.timestamp);
    return NextResponse.json({ snapshots });
  }

  const snap = await adminDb.ref(`liveOdds/${tournamentId}`).get();
  if (!snap.exists()) return NextResponse.json({ odds: null });

  return NextResponse.json({ ...snap.val(), cached: true });
}
