import { NextRequest, NextResponse } from 'next/server';
import { TOP_10_POINTS } from '@/lib/constants';
import { getAdminServices, pushToAllUsers } from '@/lib/fcm-admin';

// Cron: runs at midnight UTC = 8 PM ET every day (schedule: "0 0 * * *")
// Generates a daily AI summary of tournament activity and stores it in Firebase.
// Round 4 generates an extended championship recap including score progression
// and draft grades vs results analysis.
// Uses OpenAI API (gpt-4o-mini) and Firebase Admin SDK (bypasses security rules).

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function callAI(prompt: string, maxTokens = 1500, temperature = 0.95): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    console.error('[daily-summary] OPENAI_API_KEY not set');
    return null;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[daily-summary] OpenAI error:', res.status, err);
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    console.error('[daily-summary] OpenAI fetch error:', e);
    return null;
  }
}

export async function GET(req: NextRequest) {
  // Verify cron secret
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return generateSummary();
}

// Also allow admin to trigger manually
export async function POST(req: NextRequest) {
  const { secret, tournamentId, round } = await req.json();
  if (secret !== process.env.CRON_SECRET && secret !== process.env.NEXT_PUBLIC_ADMIN_SEED_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return generateSummary(tournamentId, typeof round === 'number' ? round : undefined);
}

async function generateSummary(forceTournamentId?: string, forceRound?: number) {
  try {
    // Use Admin SDK for all Firebase operations — bypasses security rules
    const { db: adminDb, messaging } = getAdminServices();

    // Find the currently active tournament
    const tournamentsSnap = await adminDb.ref('tournaments').get();
    if (!tournamentsSnap.exists()) return NextResponse.json({ error: 'No tournaments' });

    const tournaments = Object.values(tournamentsSnap.val()) as Array<{
      id: string; name: string; status: string; cutLine: number; maxPicks: number;
    }>;

    const activeTournament = forceTournamentId
      ? tournaments.find((t) => t.id === forceTournamentId)
      : tournaments.find((t) => t.status === 'active');

    if (!activeTournament) {
      return NextResponse.json({ skipped: true, reason: 'No active tournament' });
    }

    const tournamentId = activeTournament.id;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Check if we already generated today's summary (unless force-triggered by admin)
    if (!forceTournamentId) {
      const existingSnap = await adminDb.ref(`dailySummaries/${tournamentId}/${today}`).get();
      if (existingSnap.exists()) {
        return NextResponse.json({ skipped: true, reason: 'Already generated today' });
      }
    }

    // Load core data
    const [draftSnap, usersSnap, playersSnap] = await Promise.all([
      adminDb.ref(`drafts/${tournamentId}`).get(),
      adminDb.ref('users').get(),
      adminDb.ref(`players/${tournamentId}`).get(),
    ]);

    if (!draftSnap.exists()) return NextResponse.json({ error: 'No draft' });

    const draftState = draftSnap.val();
    const users = usersSnap.exists()
      ? (Object.values(usersSnap.val()) as Array<{ uid: string; username: string }>)
      : [];
    const playersMap = playersSnap.exists() ? playersSnap.val() : {};

    const picks = draftState.picks ?? [];
    const cutLine = activeTournament.cutLine;

    // Derive round: admin can override via forceRound; otherwise infer from player data
    let currentRound: number;
    if (forceRound && forceRound >= 1 && forceRound <= 4) {
      currentRound = forceRound;
    } else {
      const playerValues = Object.values(playersMap) as Array<{ currentRound?: number; round?: number }>;
      currentRound = playerValues.length > 0
        ? Math.max(1, ...playerValues.map(p => p.currentRound ?? p.round ?? 1).filter(r => r > 0 && r <= 4))
        : 1;
    }
    const dayLabel = currentRound === 1 ? 'Round 1'
      : currentRound === 2 ? 'Round 2'
      : currentRound === 3 ? 'Round 3'
      : 'Final Round';

    const isFinalRound = currentRound === 4;

    // For Round 4: also load trend snapshots and draft grades
    let trendSnapshotsRaw: Record<string, { timestamp: number; hour: string; scores: Record<string, number> }> = {};
    let draftGradesRaw: Record<string, { userId: string; username: string; grade: string; winPct: number; summary: string }> = {};

    if (isFinalRound) {
      const [trendSnap, gradesSnap] = await Promise.all([
        adminDb.ref(`trendSnapshots/${tournamentId}`).get(),
        adminDb.ref(`draftGrades/${tournamentId}`).get(),
      ]);
      if (trendSnap.exists()) trendSnapshotsRaw = trendSnap.val();
      if (gradesSnap.exists()) draftGradesRaw = gradesSnap.val();
    }

    // Build team summaries with live scores
    interface PlayerEntry {
      name: string;
      position: string;
      score: string;
      thru: string;
      status: string;
      points: number;
    }

    interface TeamEntry {
      userId: string;
      username: string;
      players: PlayerEntry[];
      top3Score: number;
      rank: number;
    }

    const teams: TeamEntry[] = [];

    for (const user of users) {
      const myPicks = picks.filter((p: { userId: string }) => p.userId === user.uid);
      if (myPicks.length === 0) continue;

      const players: PlayerEntry[] = myPicks.map((p: { playerName: string; playerId: string }) => {
        const pd = playersMap[p.playerId] ?? playersMap[p.playerName] ?? {};
        const position = typeof pd.position === 'number' ? pd.position : null;
        const status = pd.status ?? 'active';

        let points = 9999;
        if (status === 'cut' || status === 'wd' || status === 'dq') {
          points = cutLine + 1;
        } else if (position !== null && position > 0) {
          points = position <= 10 ? TOP_10_POINTS[position - 1] : position;
        }

        return {
          name: p.playerName,
          position: pd.positionDisplay ?? '-',
          score: pd.score ?? '-',
          thru: pd.thru ?? '-',
          status,
          points,
        };
      });

      const sorted = [...players].sort((a, b) => a.points - b.points);
      const top3 = sorted.slice(0, 3);
      const top3Score = top3.reduce((sum, p) => sum + (p.points < 9000 ? p.points : 0), 0);

      teams.push({ userId: user.uid, username: user.username, players, top3Score, rank: 0 });
    }

    // Rank teams
    teams.sort((a, b) => a.top3Score - b.top3Score);
    teams.forEach((t, i) => { t.rank = i + 1; });

    const totalTeams = teams.length;

    // ── Scoring system explanation (plain English, used in all prompts) ────────
    // IMPORTANT: TOP_10_POINTS are negative (e.g. T1 = -25). Position 11+ = positive.
    // Lower team total = WINNING. Most negative = champion.
    const scoringRules = [
      `League: ${totalTeams} teams. Each team drafts ${activeTournament.maxPicks} golfers; the BEST 3 count.`,
      `HOW POINTS WORK (lower = better, negative = great):`,
      `  • Finish T1  → ${TOP_10_POINTS[0]} pts (best possible)`,
      `  • Finish T2  → ${TOP_10_POINTS[1]} pts`,
      `  • Finish T3  → ${TOP_10_POINTS[2]} pts`,
      `  • Finish T5  → ${TOP_10_POINTS[4]} pts`,
      `  • Finish T10 → ${TOP_10_POINTS[9]} pts`,
      `  • Finish T11+ → position number as positive pts (e.g. T15 = +15 pts, bad)`,
      `  • Missed cut / WD → ${activeTournament.cutLine + 1} pts (worst outcome)`,
      `The team with the LOWEST (most negative) 3-player total WINS the tournament.`,
    ].join('\n');

    // ── Plain-English standings block (used in R1–R3 prompts) ─────────────────
    const ordinal = (n: number) => {
      const s = ['th','st','nd','rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    const teamsBlock = teams.map((t) => {
      const sorted = [...t.players].sort((a, b) => a.points - b.points);
      const top3  = sorted.slice(0, activeTournament.maxPicks - 1 < 3 ? sorted.length : 3);
      const bench = sorted.slice(top3.length);
      const scoreLabel = t.top3Score < 0
        ? `${t.top3Score} pts (negative = great, top-10 bonuses)`
        : `+${t.top3Score} pts`;
      const pline = (p: PlayerEntry, counting: boolean) => {
        if (p.points >= 9000) return `    [${counting ? 'counts' : 'bench'}] ${p.name}: not yet scored`;
        const pLabel = p.points < 0
          ? `${p.points} pts (top-10 bonus!)`
          : p.status === 'cut' ? `+${p.points} pts (missed cut — worst)`
          : p.status !== 'active' ? `${p.status.toUpperCase()}`
          : `+${p.points} pts (position ${p.position})`;
        return `    [${counting ? 'counts' : 'bench'}] ${p.name}: ${p.position || 'NS'} — ${pLabel}`;
      };
      return [
        `${ordinal(t.rank)}: ${t.username} — ${scoreLabel}`,
        ...top3.map(p => pline(p, true)),
        ...bench.map(p => pline(p, false)),
      ].join('\n');
    }).join('\n\n');

    // ── Build extra context blocks for Round 4 ────────────────────────────────

    let progressionBlock = '';
    let gradesBlock = '';

    if (isFinalRound) {
      // Score progression: show as RANKINGS at each snapshot (not raw scores)
      // This prevents the AI from misinterpreting negative fantasy points as golf scores
      const snapshots = Object.values(trendSnapshotsRaw)
        .sort((a, b) => a.timestamp - b.timestamp);

      if (snapshots.length > 0) {
        const lines = snapshots.map(snap => {
          const ranked = teams
            .map(t => ({ username: t.username, score: snap.scores[t.userId] ?? 9999 }))
            .sort((a, b) => a.score - b.score);
          const display = ranked.map((t, i) => `${i + 1}.${t.username}`).join(' → ');
          return `${snap.hour}: ${display}`;
        });
        progressionBlock = [
          'Standings order at each hourly snapshot (1st = leading = BEST):',
          ...lines,
        ].join('\n');
      }

      // Draft grades vs final results — plain-English sentences
      const gradeLookup = (t: TeamEntry) =>
        Object.values(draftGradesRaw).find(
          (gr) => gr.userId === t.userId || gr.username === t.username
        );

      const teamsWithGrades = teams.map(t => ({ ...t, g: gradeLookup(t) }));
      const sortedByWinPct = [...teamsWithGrades]
        .sort((a, b) => (b.g?.winPct ?? 0) - (a.g?.winPct ?? 0));
      const projectedRankMap = Object.fromEntries(sortedByWinPct.map((t, i) => [t.userId, i + 1]));

      const gradeLines = teams.map(t => {
        const g = gradeLookup(t);
        const finishLabel = t.rank === 1 ? 'WON THE TOURNAMENT'
          : t.rank === totalTeams ? `finished LAST (${ordinal(t.rank)} of ${totalTeams})`
          : `finished ${ordinal(t.rank)} of ${totalTeams}`;
        if (!g) return `${t.username}: ${finishLabel} — no pre-tournament grade on record`;
        const projRank = projectedRankMap[t.userId];
        const rankDiff = projRank - t.rank;
        const perf = rankDiff > 1 ? 'OUTPERFORMED expectations'
          : rankDiff < -1 ? 'UNDERPERFORMED expectations'
          : 'met expectations';
        return `${t.username}: AI predicted ${ordinal(projRank)} (grade ${g.grade}, ${g.winPct}% win chance) → ACTUALLY ${finishLabel} → ${perf}. AI said: "${g.summary}"`;
      });
      gradesBlock = gradeLines.join('\n');
    }

    let prompt: string;
    let jsonShape: string;

    const winner = teams[0]; // rank 1 = champion (lowest team score)
    const last   = teams[teams.length - 1];

    if (isFinalRound) {
      // Build a plain-English standings summary in CODE so the AI
      // never has to interpret the scoring math — it just adds personality.
      const standingsSentences = teams.map(t => {
        const sorted = [...t.players].sort((a, b) => a.points - b.points);
        const top3 = sorted.slice(0, 3);
        const top3Names = top3
          .filter(p => p.points < 9000)
          .map(p => {
            const bonus = p.points < 0 ? ` (top-10 bonus)` : p.status === 'cut' ? ` (missed cut)` : '';
            return `${p.name} at ${p.position || '—'}${bonus}`;
          }).join(', ');
        const finishLabel = t.rank === 1 ? '🏆 1st place WINNER'
          : t.rank === 2 ? '2nd place'
          : t.rank === totalTeams ? `last place (${ordinal(t.rank)})`
          : `${ordinal(t.rank)} place`;
        return `${finishLabel}: ${t.username} — Best 3 golfers: ${top3Names || 'none scored yet'}`;
      }).join('\n');

      prompt = `You are writing the CHAMPIONSHIP FINAL RECAP for ${activeTournament.name} for a private fantasy golf draft league of close friends.

YOUR ONLY JOB: Take the pre-written factual summary below and make it funny, punchy, and worth reading. Add banter, roasting, drama, and personality. DO NOT invent any names, results, or rankings — every fact is already written for you. Your creative input is TONE ONLY.

════════════════════════════════════════
LOCKED FACTS — DO NOT CHANGE ANY OF THIS
════════════════════════════════════════

THE TOURNAMENT WINNER IS: ${winner.username}
THE RUNNER-UP IS: ${teams[1]?.username ?? 'N/A'}
LAST PLACE IS: ${last.username}

${scoringRules}

FINAL STANDINGS (copy these names and places exactly):
${standingsSentences}

${progressionBlock ? `HOW THE LEAD CHANGED OVER THE WEEK (1st = leading at that moment):
${progressionBlock}
` : ''}${gradesBlock ? `PRE-TOURNAMENT PREDICTIONS VS ACTUAL RESULTS:
${gradesBlock}
` : ''}
════════════════════════════════════════
YOUR CREATIVE TASK
════════════════════════════════════════

Write six sections using ONLY the facts above. Add humor, roasting, drama, and personality — but never change a name, a finish position, or a ranking:

1. **FINAL STANDINGS BREAKDOWN** (~4-5 sentences): Crown ${winner.username} as champion. Roast the lower finishers. Be dramatic — this is the finale. Reference specific golfer names from the standings.

2. **HERO & ZERO OF THE TOURNAMENT** (2-3 sentences each): Pick one golfer as the Hero (best performer for their team across the whole week) and one as the Zero (biggest bust). Use names from the data.

3. **TOURNAMENT CHAMPION VERDICT** (~3 sentences): Declare ${winner.username} the winner. Explain why they won based on their golfers' finishes. Cheeky send-off to everyone else.

4. **TOURNAMENT JOURNEY** (~3-4 sentences): Using the progression data, describe who led early and how it changed. Reference the team names from the standings-over-time data above.

5. **SCORE CHART ANALYSIS** (~3 sentences): What was the most dramatic shift in the standings? Who was on a streak, who collapsed?

6. **DRAFT REPORT CARD** (~4-5 sentences): For each team, compare the pre-tournament prediction to the actual result. Call out the biggest hit (correctly predicted winner?) and miss (predicted to win, finished last?).

Respond ONLY with valid JSON — no markdown, no backticks, no extra text:
{
  "dayLabel": "Final Round",
  "standingsBreakdown": "...",
  "heroName": "...",
  "heroTeam": "...",
  "heroSummary": "...",
  "zeroName": "...",
  "zeroTeam": "...",
  "zeroSummary": "...",
  "outlook": "...",
  "tournamentJourney": "...",
  "chartAnalysis": "...",
  "draftReportCard": "..."
}`;

      jsonShape = `{
  "dayLabel", "standingsBreakdown", "heroName", "heroTeam", "heroSummary",
  "zeroName", "zeroTeam", "zeroSummary", "outlook",
  "tournamentJourney", "chartAnalysis", "draftReportCard"
}`;
      void jsonShape;
    } else {
      prompt = `You are a hilariously snarky but genuinely insightful fantasy golf analyst recapping ${dayLabel} of ${activeTournament.name} for a private fantasy draft league of friends. Be funny, use sports banter, roast the losers, hype the leaders. Keep it punchy and fun.

${scoringRules}

CURRENT STANDINGS after ${dayLabel} (1st place = winning = lowest points):
${teamsBlock}

Write a daily summary with THREE sections. Use ONLY names and rankings from the data above — do not invent results.

1. **STANDINGS BREAKDOWN** (~3-4 sentences): Who's leading and why? Roast the cellar dwellers, hype the leaders. Reference the specific golfers and their positions.

2. **HERO & ZERO OF THE DAY** (2 sentences each): Hero = best individual golfer performance today (lowest pts / best position). Zero = biggest bust. Name the golfer AND the team owner.

3. **TOURNAMENT OUTLOOK** (~2-3 sentences): Who realistically wins from here? Who should start planning their concession speech?

Use the actual player names and usernames from the standings. Add humor but keep the names and positions accurate.

Respond ONLY with valid JSON — no markdown, no backticks, no extra text:
{
  "dayLabel": "${dayLabel}",
  "standingsBreakdown": "...",
  "heroName": "...",
  "heroTeam": "...",
  "heroSummary": "...",
  "zeroName": "...",
  "zeroTeam": "...",
  "zeroSummary": "...",
  "outlook": "..."
}`;
    }

    // R4: much lower temperature — the facts are pre-written, AI only adds tone
    const text = await callAI(prompt, isFinalRound ? 2500 : 1500, isFinalRound ? 0.5 : 0.9);
    if (!text) {
      return NextResponse.json({ error: 'AI generation failed — check OPENAI_API_KEY env variable' }, { status: 500 });
    }

    let summaryContent: Record<string, string>;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      summaryContent = JSON.parse(clean);
    } catch {
      console.error('[daily-summary] JSON parse failed:', text);
      return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 500 });
    }

    const summary = {
      ...summaryContent,
      tournamentId,
      tournamentName: activeTournament.name,
      date: today,
      isFinalRound,
      generatedAt: Date.now(),
      seen: {},  // tracks which users have dismissed it
    };

    // Write via Admin SDK — bypasses the ".write: false" client rule on dailySummaries
    await adminDb.ref(`dailySummaries/${tournamentId}/${today}`).set(summary);

    // Push notification to all users
    try {
      const summaryDayLabel = (summary as { dayLabel?: string }).dayLabel ?? 'Today\'s';
      const url = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/recaps`;
      const notifTitle = isFinalRound
        ? `🏆 Championship Recap — ${activeTournament.name}`
        : `📋 ${summaryDayLabel} Recap — ${activeTournament.name}`;
      const notifBody = isFinalRound
        ? 'The full tournament recap, score progression, and draft report card are ready.'
        : 'The round summary and standings breakdown are ready. Check Recaps.';
      await pushToAllUsers(messaging, adminDb, notifTitle, notifBody, url);
    } catch (e) {
      console.warn('[daily-summary] push notification failed:', e);
    }

    return NextResponse.json({ ok: true, date: today, summary });
  } catch (err) {
    console.error('[daily-summary]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
