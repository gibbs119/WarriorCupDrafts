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
    const teamsBlock = teams.map((t) => {
      const playerLines = t.players.map((p) => {
        const pts = p.points >= 9000 ? 'NS' : (p.points > 0 ? `+${p.points}` : `${p.points}`);
        return `    ${p.name}: Pos ${p.position}, Score ${p.score}, Thru ${p.thru}${p.status !== 'active' ? ` [${p.status.toUpperCase()}]` : ''}, Pts: ${pts}`;
      }).join('\n');
      return `#${t.rank} ${t.username} (Team Score: ${t.top3Score > 0 ? '+' : ''}${t.top3Score}):\n${playerLines}`;
    }).join('\n\n');

    // ── Build extra context blocks for Round 4 ────────────────────────────────

    let progressionBlock = '';
    let gradesBlock = '';

    if (isFinalRound) {
      // Score progression: hourly snapshots sorted chronologically
      const snapshots = Object.values(trendSnapshotsRaw)
        .sort((a, b) => a.timestamp - b.timestamp);

      if (snapshots.length > 0) {
        const userMap = Object.fromEntries(users.map(u => [u.uid, u.username]));
        const lines = snapshots.map(snap => {
          const scores = teams.map(t => {
            const s = snap.scores[t.userId];
            const display = (s === undefined || s >= 9000) ? 'NS' : (s > 0 ? `+${s}` : `${s}`);
            return `${t.username}=${display}`;
          }).join(', ');
          void userMap;
          return `${snap.hour}: ${scores}`;
        });
        progressionBlock = lines.join('\n');
      }

      // Draft grades vs final results — structured comparison table
      const gradeLookup = (t: TeamEntry) =>
        Object.values(draftGradesRaw).find(
          (gr) => gr.userId === t.userId || gr.username === t.username
        );

      // Compute projected pre-tournament rankings from win% (higher win% = projected higher rank)
      const teamsWithGrades = teams.map(t => ({ ...t, g: gradeLookup(t) }));
      const sortedByWinPct = [...teamsWithGrades]
        .sort((a, b) => (b.g?.winPct ?? 0) - (a.g?.winPct ?? 0));
      const projectedRankMap = Object.fromEntries(sortedByWinPct.map((t, i) => [t.userId, i + 1]));

      const gradeLines = teams.map(t => {
        const g = gradeLookup(t);
        if (!g) return `${t.username}: Actual Rank #${t.rank} | No pre-tournament grade recorded`;
        const projRank = projectedRankMap[t.userId];
        const rankDiff = projRank - t.rank; // positive = outperformed expectations
        const perf = rankDiff > 1 ? 'OUTPERFORMED' : rankDiff < -1 ? 'UNDERPERFORMED' : 'MET EXPECTATIONS';
        return `${t.username}: Grade ${g.grade} | Win% ${g.winPct}% | Projected Rank #${projRank} | Actual Rank #${t.rank} | ${perf} — "${g.summary}"`;
      });
      gradesBlock = gradeLines.join('\n');
    }

    // ── Build the prompt ──────────────────────────────────────────────────────

    const scoringRules = `The league has ${totalTeams} teams. Best 3 of ${activeTournament.maxPicks} drafted players count toward team score. Lower score is better (golf scoring). Top 10 point bonuses: ${TOP_10_POINTS.map((p, i) => `${i + 1}: ${p}`).join(', ')}. Position 11+: points = position number. Cut/WD = cut line + 1.`;

    let prompt: string;
    let jsonShape: string;

    const winner = teams[0]; // rank 1 = champion

    if (isFinalRound) {
      prompt = `You are writing the CHAMPIONSHIP FINAL RECAP for ${activeTournament.name} for a private fantasy golf draft league of close friends. This is the biggest recap of the tournament — the full story, the drama, the winners, the collapses. Be genuinely funny, use banter and roasting, but also deliver real analytical insight. This one matters.

⚠️ GROUND TRUTH — ALL DATA BELOW IS EXACT AND FINAL. DO NOT CHANGE NAMES, RANKINGS, OR INVENT RESULTS:
TOURNAMENT CHAMPION: ${winner.username} (Team Score: ${winner.top3Score > 0 ? '+' : ''}${winner.top3Score})
RUNNER-UP: ${teams[1]?.username ?? 'N/A'}
LAST PLACE: ${teams[teams.length - 1]?.username ?? 'N/A'}

${scoringRules}

FINAL STANDINGS (1 = winner, ranked by lowest team score):
${teamsBlock}

${progressionBlock ? `SCORE PROGRESSION (hourly snapshots, lower team score = better):
${progressionBlock}

` : ''}${gradesBlock ? `DRAFT GRADE VS ACTUAL RESULT TABLE (use these exact ranks and grades — do not invent):
${gradesBlock}

` : ''}Write a championship recap with SIX sections:

1. **FINAL STANDINGS BREAKDOWN** (~4-5 sentences): Crown the champion properly. Roast the losers. Call out the biggest moves of the final round. Be dramatic — this is the finale.

2. **HERO & ZERO OF THE TOURNAMENT** (2-3 sentences each): Not just today — the single most impactful drafted player of the ENTIRE tournament (Hero) and the biggest overall bust (Zero).

3. **TOURNAMENT CHAMPION VERDICT** (~3 sentences): Declare the winner, explain how they won it, and give a cheeky send-off to the rest of the field. This replaces the usual "Outlook" section.

4. **TOURNAMENT JOURNEY** (~3-4 sentences): Using the score progression data, describe how the tournament unfolded over the week — who dominated early, who made a late charge, which team's lead evaporated. Tell the arc of the whole week.

5. **SCORE CHART ANALYSIS** (~3 sentences): Look at the progression snapshots and call out the most dramatic moment — a team that rocketed up, one that cratered, or the closest finish. Make it vivid.

6. **DRAFT REPORT CARD** (~4-5 sentences): Compare each team's pre-tournament draft grade against their actual finish. Who was correctly scouted? Who was overrated? Who was the sleeper that outperformed expectations? Be specific with names and grades.

Use actual player names and usernames from the data. Be creative, punchy, funny, and genuine.
REMINDER: The champion is ${winner.username}. Do not contradict the standings data above.

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
      prompt = `You are a hilariously snarky but genuinely insightful fantasy golf analyst recapping ${dayLabel} of ${activeTournament.name} for a private fantasy draft league of friends. Be funny, use sports banter, roast the losers, hype the leaders, and make specific observations about players' actual rounds. Keep it punchy and fun — like a group chat message from the most golf-obsessed person you know.

${scoringRules}

Here are the current standings after ${dayLabel}:

${teamsBlock}

Write a daily summary with THREE sections:

1. **STANDINGS BREAKDOWN** (~3-4 sentences): Roast the cellar dwellers, hype the leaders, and give specific commentary about what happened today — whose picks came alive, who got burned.

2. **HERO & ZERO OF THE DAY** (2 sentences each): Name the single best-performing drafted player across all teams ("Hero") and the biggest disappointment ("Zero"). Be dramatic about it.

3. **TOURNAMENT OUTLOOK** (~2-3 sentences): Based on where things stand, who's got a realistic path to win and who should start planning their concession speech. Make it fun.

Use actual player names and usernames from the data. Be creative, be funny, don't hold back on the roasting. But make it feel genuine — real analysis wrapped in a joke.

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

    // R4: lower temperature to reduce hallucination on factual winner/standings data
    const text = await callAI(prompt, isFinalRound ? 2500 : 1500, isFinalRound ? 0.7 : 0.95);
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
