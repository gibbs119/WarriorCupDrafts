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
// Major championship: typical single-round stroke std-dev for a PGA Tour pro.
// Drives the Monte Carlo spread — lower = tighter, higher = wider.
const MAJOR_ROUND_STROKE_SD = 3.5;

function fantasyPts(position: number | null, status: string, cutLine: number): number {
  if (status === 'cut' || status === 'wd' || status === 'dq') return cutLine + 1;
  if (!position || position === 0) return 9999;
  return position <= 10 ? TOP_10_POINTS[position - 1] : position;
}

// Points swing if player moves from their current position to T10 (or vice versa).
function top10Swing(position: number | null, status: string, cutLine: number): number | null {
  if (status !== 'active' || !position || position === 0) return null;
  const currentPts = fantasyPts(position, status, cutLine);
  if (position <= 10) {
    return 11 - currentPts;
  } else {
    return currentPts - TOP_10_POINTS[9]; // pts gained by entering T10
  }
}

// Parse a stroke score string ("E", "-5", "+2", "-3") to an integer.
function parseStrokeScore(score: string | undefined): number | null {
  if (!score || score === '-' || score === 'N/A' || score === 'unknown') return null;
  if (score === 'E') return 0;
  const n = parseInt(score, 10);
  return isNaN(n) ? null : n;
}

// Box-Muller normal variate — used in Monte Carlo simulation.
function normalRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Binary search: returns 1-indexed position of `strokes` in a sorted ASC array.
// Ties are resolved to the same position bucket (upper-bound).
function strokesToPosition(strokes: number, sortedField: number[]): number {
  let lo = 0, hi = sortedField.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedField[mid] < strokes) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo + 1);
}

// Pre-compute the heuristic "best-case" ceiling for AI context strings.
// (Not used for win probability — Monte Carlo handles that.)
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
  if (!cutHasBeenMade && position !== null && position > cutLine) return 0;
  if (position === null) return Math.round((cutLine + 1) * 0.04);

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
    let cutLine      = tournament?.cutLine ?? 65;
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

    // Build a normalized-name lookup so picks stored with name-based IDs (instead of
    // ESPN numeric IDs) are still found. Mirrors the mergedMap pattern in the leaderboard page.
    const nameLookup = new Map<string, PlayerEntry>();
    for (const player of Object.values(playersMap)) {
      if (player.name) {
        const key = player.name
          .toLowerCase().normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/\./g, '')
          .replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
        nameLookup.set(key, player);
      }
    }

    function lookupPlayer(playerId: string, playerName: string): PlayerEntry {
      // 1. ESPN numeric ID (fast path — works for all modern picks)
      if (playersMap[playerId]) return playersMap[playerId];
      // 2. Normalized name of playerName
      if (playerName) {
        const key = playerName
          .toLowerCase().normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/\./g, '')
          .replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
        const byName = nameLookup.get(key);
        if (byName) return byName;
        // 3. Treat playerId itself as a name slug (legacy picks before ESPN field loaded)
        const byId = nameLookup.get(
          playerId.toLowerCase().normalize('NFD')
            .replace(/[̀-ͯ]/g, '').replace(/\./g, '')
            .replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim()
        );
        if (byId) return byId;
      }
      return {} as PlayerEntry;
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
    // After the cut, derive cutLine from survivor count so cutLine+1 = correct penalty.
    // e.g. PGA 2026: 82 survivors → cutLine=82 → missed-cut penalty = 83pts.
    if (cutHasBeenMade && allActivePlayers.length > 0) {
      cutLine = allActivePlayers.length;
    }

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
        const pd = lookupPlayer(p.playerId, p.playerName);
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
    console.log('[live-odds] computed team scores:', teams.map(t => ({
      name: t.username,
      top3Score: t.top3Score,
      players: t.players.map(p => `${p.name}(${p.position ?? 'null'}→${p.points < 9000 ? p.points : 'NF'})`),
    })));

    teams.forEach((t, i) => { t.rank = i + 1; t.canReallyWin = true; }); // set after MC below

    const hasRealScores = teams.some(t => t.players.some(p => p.points < 9000));
    if (!hasRealScores) {
      return NextResponse.json({ error: 'No live scores yet' }, { status: 404 });
    }

    const totalTeams     = teams.length;
    const tournamentName = tournament?.name ?? tournamentId;

    // ── Monte Carlo win-probability simulation ────────────────────────────────
    // Model: each player's final stroke score = current + N(0, σ) where
    // σ = MAJOR_ROUND_STROKE_SD × √(holesLeft/18).  Simulated position is
    // looked up in a static sorted field (current active player strokes).
    // The non-linear TOP_10_POINTS jump structure is preserved automatically.
    const sortedFieldStrokes = Object.values(playersMap)
      .filter(p => p.status === 'active')
      .map(p => parseStrokeScore(p.score) ?? 0)
      .sort((a, b) => a - b);

    const N_SIMS = 3000;
    const winCounts = new Array(teams.length).fill(0);

    for (let sim = 0; sim < N_SIMS; sim++) {
      const teamSims = teams.map(team => {
        const simPts = team.players.map(p => {
          if (p.scoreLocked || p.status === 'cut' || p.status === 'wd' || p.status === 'dq') {
            return p.points; // locked — no variance
          }
          if (p.points >= 9000) return 20; // unstarted → conservative T20

          const holesLeft = p.totalTournamentHolesLeft;
          if (holesLeft <= 0) return p.points;

          const strokeSd = MAJOR_ROUND_STROKE_SD * Math.sqrt(holesLeft / 18);
          const currentStrokes = parseStrokeScore(p.score) ?? 0;
          const simStrokes = currentStrokes + normalRandom() * strokeSd;
          const simPos = strokesToPosition(simStrokes, sortedFieldStrokes);
          return fantasyPts(simPos, p.status, cutLine);
        });
        // Best 3 of N
        return simPts.sort((a, b) => a - b).slice(0, 3).reduce((s, pts) => s + pts, 0);
      });

      const minScore = Math.min(...teamSims);
      // Handle ties: split the win
      const winnerIdxs = teamSims.map((s, i) => s === minScore ? i : -1).filter(i => i >= 0);
      for (const i of winnerIdxs) winCounts[i] += 1 / winnerIdxs.length;
    }

    // Convert raw counts to rounded percentages, floor impossibly-far teams at 1%
    const rawPcts = winCounts.map(c => (c / N_SIMS) * 100);
    // Teams with <0.5% raw chance are mathematically eliminated → floor 1%
    const mcWinPcts: number[] = rawPcts.map(p => (p < 0.5 ? 0 : p));
    const eliminated = rawPcts.map(p => p < 0.5);

    // Normalise to 100, then assign 1% floor to eliminated teams from leader's share
    let normalSum = mcWinPcts.reduce((s, p) => s + p, 0);
    const finalPcts = mcWinPcts.map((p, i) => {
      if (eliminated[i]) return 1;
      return Math.max(1, Math.round((p / normalSum) * (100 - eliminated.filter(Boolean).length)));
    });
    // Fix rounding to exactly 100
    const ptSum = finalPcts.reduce((s, p) => s + p, 0);
    if (ptSum !== 100) {
      const leaderIdx = finalPcts.indexOf(Math.max(...finalPcts));
      finalPcts[leaderIdx] += 100 - ptSum;
    }

    // Mark canReallyWin for prompt context (teams with >1% have a real shot)
    teams.forEach((t, i) => { t.canReallyWin = finalPcts[i] > 1; });

    console.log('[live-odds] MC win%:', teams.map((t, i) => `${t.username}:${finalPcts[i]}%`).join(' '));

    // ── Format each player line with full context ────────────────────────────
    const teamsBlock = teams.map((t, idx) => {
      const scoreStr = t.top3Score > 0 ? `+${t.top3Score}` : `${t.top3Score}`;
      const winPctStr = finalPcts[idx];
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
          ? `INSIDE T10 at ${p.posDisplay} (${p.top10PtSwing !== null ? `${p.top10PtSwing}pt cliff to T11` : ''})`
          : `outside T10 by ${p.spotsFromTop10} spots (${p.top10PtSwing !== null ? `entering T10 = ${p.top10PtSwing}pt swing` : ''})`;
        const pts = p.points <= 0 ? `${p.points}` : `+${p.points}`;

        return `    [${role}] ${p.name}: ${p.posDisplay}, Score ${p.score}${strokeCtx}${roundScorePart}${lockTag}, HolesLeft ${p.totalTournamentHolesLeft}, Pts ${pts} — ${top10Tag}`;
      }).join('\n');

      const benchLine = (t.bestBench && t.gapToCount !== null && t.gapToCount > 0)
        ? `\n  BENCH UPSIDE: ${t.bestBench.name} (${t.bestBench.posDisplay}, Pts ${t.bestBench.points > 0 ? '+' : ''}${t.bestBench.points}) needs ${t.gapToCount}pt to enter counting (${t.bestBench.totalTournamentHolesLeft} holes left)`
        : '';

      const overtakeLine = gapToNext !== null && gapToNext > 0
        ? `\n  OVERTAKE: Need ${gapToNext}pt net swing to pass #${t.rank - 1} (${teamAbove!.username})`
        : '';

      return `#${t.rank} ${t.username} (Score: ${scoreStr} | MC Win%: ${winPctStr}%):${overtakeLine}${benchLine}\n${playerLines}`;
    }).join('\n\n');

    // ── Prompt — AI generates NARRATIVE ONLY, win% are server-computed ────────
    const prompt = `You are a fantasy golf analyst narrating live odds for ${tournamentName} (${totalTeams}-person private league).

SCORING: Best 3 of ${maxPicks} drafted players count. Lower = better.
Top-10 pts: ${TOP_10_POINTS.map((p, i) => `T${i+1}=${p}`).join(', ')}. T11+: pts = position. Cut/WD/DQ: +${cutLine+1} (locked).
KEY: T11→T10 = 12pt swing. T2→T1 = 10pt swing. The T10 boundary is the biggest lever.

TOURNAMENT: ${roundLabel} of ${TOTAL_ROUNDS}. Rounds remaining: ${roundsRemaining}.
With ${roundsRemaining >= 1 ? 'a full round remaining' : 'only this round left'}, even a 20pt lead is fragile — a 4-stroke swing at the top can flip the entire leaderboard.
T10 cutline score: ${cutlineScore}.

WIN PROBABILITIES (server-computed via Monte Carlo, 3 000 simulations — DO NOT change these numbers):
${teams.map((t, i) => `  ${t.username}: ${finalPcts[i]}%`).join('\n')}

LIVE STANDINGS:
${teamsBlock}

Your job: write ONE punchy insight sentence per team (explain WHY they have that win%), and a 2–3 sentence overall analysis.
- Reference actual names, specific pt gaps, the T10 boundary, and remaining holes.
- For teams with 1% (mathematically eliminated), explain the gap honestly.
- For contenders, name the specific scenario that gets them to victory.

Respond ONLY with valid JSON — no markdown, no backticks:
{
  "analysis": "2-3 sentence overall narrative",
  "odds": [
    { "username": "...", "trend": "up", "insight": "one sharp sentence" }
  ]
}
trend: "up" if team improved since this round started, "down" if regressing, "stable" if holding.`;

    const text = await callOpenAI(prompt);
    if (!text) {
      return NextResponse.json({
        error: 'AI generation failed — check OPENAI_API_KEY env variable',
      }, { status: 500 });
    }

    let parsed: {
      analysis: string;
      odds: Array<{ username: string; trend: string; insight: string }>;
    };
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error('[live-odds] JSON parse failed:', text);
      return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 500 });
    }

    // Merge server winPcts with AI insight/trend (AI never sets the numbers)
    const oddsWithIds = teams.map((team, i) => {
      const aiEntry = parsed.odds.find(o => o.username === team.username);
      return {
        userId:   team.userId,
        username: team.username,
        winPct:   finalPcts[i],  // always server MC value
        trend:    (aiEntry?.trend as 'up' | 'down' | 'stable') ?? 'stable',
        insight:  aiEntry?.insight ?? '',
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
