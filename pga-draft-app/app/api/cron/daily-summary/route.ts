import { NextRequest, NextResponse } from 'next/server';
import { TOP_10_POINTS } from '@/lib/constants';
import { getAdminServices, pushToAllUsers } from '@/lib/fcm-admin';

// Cron: runs at midnight UTC = 8 PM ET every day (schedule: "0 0 * * *")
// Generates a daily AI summary of tournament activity and stores it in Firebase.
// Users see it as a modal the next time they open the app.
// Uses OpenAI API (gpt-4o-mini) and Firebase Admin SDK (bypasses security rules).

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function callAI(prompt: string): Promise<string | null> {
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
        max_tokens: 1500,
        temperature: 0.95,
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

    // Load all the data we need
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

      teams.push({ username: user.username, players, top3Score, rank: 0 });
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

    const prompt = `You are a hilariously snarky but genuinely insightful fantasy golf analyst recapping ${dayLabel} of ${activeTournament.name} for a private fantasy draft league of friends. Be funny, use sports banter, roast the losers, hype the leaders, and make specific observations about players' actual rounds. Keep it punchy and fun — like a group chat message from the most golf-obsessed person you know.

The league has ${totalTeams} teams. Best 3 of ${activeTournament.maxPicks} drafted players count toward team score. Lower score is better (golf scoring). Top 10 point bonuses: ${TOP_10_POINTS.map((p, i) => `${i + 1}: ${p}`).join(', ')}. Position 11+: points = position number. Cut/WD = cut line + 1.

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

    const text = await callAI(prompt);
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
      generatedAt: Date.now(),
      seen: {},  // tracks which users have dismissed it
    };

    // Write via Admin SDK — bypasses the ".write: false" client rule on dailySummaries
    await adminDb.ref(`dailySummaries/${tournamentId}/${today}`).set(summary);

    // Push notification to all users
    try {
      const summaryDayLabel = (summary as { dayLabel?: string }).dayLabel ?? 'Today\'s';
      const url = `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/recaps`;
      await pushToAllUsers(
        messaging, adminDb,
        `📋 ${summaryDayLabel} Recap — ${activeTournament.name}`,
        'The round summary and standings breakdown are ready. Check Recaps.',
        url,
      );
    } catch (e) {
      console.warn('[daily-summary] push notification failed:', e);
    }

    return NextResponse.json({ ok: true, date: today, summary });
  } catch (err) {
    console.error('[daily-summary]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
