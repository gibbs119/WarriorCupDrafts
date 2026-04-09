import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices } from '@/lib/fcm-admin';
import { TOP_10_POINTS } from '@/lib/constants';

// Generates live AI win-probability odds for each fantasy team based on current
// tournament scores. Cached in Firebase; regenerates if > 25 minutes old.
// Called automatically alongside each hourly trend snapshot (Thu–Sun, 8AM–8PM).
// Also callable manually from the Odds tab.
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
        max_tokens: 1500,
        temperature: 0.85,
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
    if (!playersSnap.exists()) return NextResponse.json({ error: 'No scores yet — tournament may not have started' }, { status: 404 });

    const draftState = draftSnap.val();
    const users = usersSnap.exists()
      ? (Object.values(usersSnap.val()) as Array<{ uid: string; username: string }>)
      : [];
    const playersMap = playersSnap.val() as Record<string, { position?: number; positionDisplay?: string; score?: string; thru?: string; status?: string }>;
    const tournament = tournamentSnap.exists() ? tournamentSnap.val() : null;
    const cutLine = tournament?.cutLine ?? 65;
    const maxPicks = tournament?.maxPicks ?? 5;

    const picks = draftState.picks ?? [];

    // Build team summaries with live scores
    interface PlayerEntry {
      name: string; position: string; score: string;
      thru: string; status: string; points: number;
    }
    interface TeamEntry {
      userId: string; username: string; players: PlayerEntry[];
      top3Score: number; rank: number;
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

        // Estimate holes remaining for variance context
        const thru = pd.thru ?? '-';
        let holesLeft = 18;
        if (thru === 'F') holesLeft = 0;
        else if (thru !== '-') holesLeft = Math.max(0, 18 - parseInt(thru, 10));

        return {
          name: p.playerName,
          position: pd.positionDisplay ?? '-',
          score: pd.score ?? '-',
          thru,
          status,
          points,
          holesLeft,
        } as PlayerEntry & { holesLeft: number };
      });

      const sorted = [...players].sort((a, b) => a.points - b.points);
      const top3 = sorted.slice(0, 3);
      const top3Score = top3.reduce((sum, p) => sum + (p.points < 9000 ? p.points : 0), 0);

      teams.push({ userId: user.uid, username: user.username, players, top3Score, rank: 0 });
    }

    if (teams.length === 0) return NextResponse.json({ error: 'No teams found' }, { status: 404 });

    // Rank teams
    teams.sort((a, b) => a.top3Score - b.top3Score);
    teams.forEach((t, i) => { t.rank = i + 1; });

    // Check if any real scores exist
    const hasRealScores = teams.some(t => t.players.some(p => p.points < 9000));
    if (!hasRealScores) {
      return NextResponse.json({ error: 'No live scores yet — tournament may not have started' }, { status: 404 });
    }

    const totalTeams = teams.length;
    const tournamentName = tournament?.name ?? tournamentId;

    const teamsBlock = teams.map((t) => {
      const playerLines = t.players.map((p) => {
        const pts = p.points >= 9000 ? 'Not Started' : (p.points > 0 ? `+${p.points}` : `${p.points}`);
        const holesLeft = (p as PlayerEntry & { holesLeft?: number }).holesLeft;
        return `    ${p.name}: Pos ${p.position}, Score ${p.score}, Thru ${p.thru}${holesLeft !== undefined ? `, HolesLeft ${holesLeft}` : ''}${p.status !== 'active' ? ` [${p.status.toUpperCase()}]` : ''}, Pts: ${pts}`;
      }).join('\n');
      const scoreStr = t.top3Score > 0 ? `+${t.top3Score}` : `${t.top3Score}`;
      return `#${t.rank} ${t.username} (Team Score: ${scoreStr}):\n${playerLines}`;
    }).join('\n\n');

    const prompt = `You are a live fantasy golf odds analyst covering ${tournamentName} for a private ${totalTeams}-person draft league. Based on current live scores and positions, give sharp win-probability odds for each fantasy team.

Scoring: Best 3 of ${maxPicks} drafted players count. Lower score = better. Top 10 bonuses: ${TOP_10_POINTS.slice(0, 10).map((p, i) => `T${i + 1}:${p}`).join(' ')}. Pos 11+: points = position number. Cut/WD/DQ = ${cutLine + 1} pts.

Live standings:
${teamsBlock}

Factor in when assigning odds:
- Current fantasy score gap between teams
- Individual player trajectories (in-round scoring, position changes)
- Holes remaining — more variance = bigger win-probability spread
- Cut/WD impact (devastating if a key scoring player got cut)
- Remaining upside from players not yet started or mid-round
- Whether the leader is running away or it's anyone's race

Respond ONLY with valid JSON — no markdown, no backticks, no extra text:
{
  "roundLabel": "Round 2",
  "analysis": "2-3 sentence punchy narrative of the current state of the fantasy race",
  "odds": [
    {
      "username": "...",
      "winPct": 35,
      "trend": "up",
      "insight": "One sharp sentence about why this team's odds look this way right now"
    }
  ]
}

Rules:
- All winPct values MUST sum to exactly 100
- trend: "up" if the team improved position/score this round, "down" if falling back, "stable" if holding
- Be genuinely analytical — not just roasting, actually assess the situation
- It's OK to give one team a dominant 50%+ if the gap is large enough`;

    const text = await callOpenAI(prompt);
    if (!text) {
      return NextResponse.json({
        error: 'AI generation failed — check OPENAI_API_KEY env variable',
      }, { status: 500 });
    }

    let parsed: {
      roundLabel: string;
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
        userId: team?.userId ?? o.username,
        username: o.username,
        winPct: o.winPct,
        trend: (o.trend as 'up' | 'down' | 'stable') ?? 'stable',
        insight: o.insight,
      };
    });

    const now = Date.now();

    const result: LiveOdds = {
      generatedAt: now,
      roundLabel: parsed.roundLabel,
      analysis: parsed.analysis,
      odds: oddsWithIds,
    };

    // Save current odds and append an hourly snapshot for the Odds Trend graph.
    // Key uses the same ISO-hour format as trendSnapshots (one entry per hour).
    const tzOffset = -4; // EDT (Masters week); close enough for label purposes
    const nowLocal = new Date(now + tzOffset * 60 * 60 * 1000);
    const hourKey  = new Date(now).toISOString().slice(0, 13); // "2026-04-10T14"
    const DAYS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow   = nowLocal.getUTCDay();
    const h     = nowLocal.getUTCHours() % 12 || 12;
    const ampm  = nowLocal.getUTCHours() < 12 ? 'AM' : 'PM';
    const hourLabel = `${DAYS[dow]} ${h}${ampm}`;
    const oddsSnap = {
      timestamp: now,
      hour: hourLabel,
      odds: Object.fromEntries(oddsWithIds.map(o => [o.userId, o.winPct])),
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
