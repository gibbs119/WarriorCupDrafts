import { NextRequest, NextResponse } from 'next/server';
import { TOURNAMENTS, TOP_10_POINTS } from '@/lib/constants';
import { getAdminServices, pushToAllUsers } from '@/lib/fcm-admin';

// Generates AI draft grades for all teams and caches them in Firebase.
// Uses Firebase Admin SDK (bypasses DB security rules — server only).
// Uses OpenAI API (gpt-4o-mini).

export interface DraftGrade {
  userId: string;
  username: string;
  grade: string;
  winPct: number;
  summary: string;
  generatedAt: number;
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function callAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey) throw new Error('OPENAI_API_KEY not set in environment variables');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.9,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned empty response');
  return text;
}

// ── POST — generate grades ────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { tournamentId, force } = body as { tournamentId?: string; force?: boolean };

    if (!tournamentId) {
      return NextResponse.json({ error: 'Missing tournamentId' }, { status: 400 });
    }

    // All DB access via Admin SDK so security rules don't block us
    const { messaging, db } = getAdminServices();

    // Return cached unless force=true
    if (!force) {
      const cached = await db.ref(`draftGrades/${tournamentId}`).get();
      if (cached.exists()) {
        return NextResponse.json({ grades: Object.values(cached.val() as Record<string, DraftGrade>), cached: true });
      }
    }

    // Load draft state, users, tournament info
    const [draftSnap, usersSnap, tournamentSnap, playersSnap] = await Promise.all([
      db.ref(`drafts/${tournamentId}`).get(),
      db.ref('users').get(),
      db.ref(`tournaments/${tournamentId}`).get(),
      db.ref(`players/${tournamentId}`).get(),
    ]);

    if (!draftSnap.exists()) {
      return NextResponse.json({ error: 'No draft found for this tournament' }, { status: 404 });
    }

    const draftState = draftSnap.val() as { picks?: Array<{ userId: string; playerName: string; playerId: string }> };
    const picks = draftState.picks ?? [];

    if (picks.length === 0) {
      return NextResponse.json({ error: 'No picks found — draft may not have started' }, { status: 400 });
    }

    const users = usersSnap.exists()
      ? Object.values(usersSnap.val() as Record<string, { uid: string; username: string }>)
      : [];

    const tournament = tournamentSnap.exists()
      ? tournamentSnap.val() as { name: string }
      : TOURNAMENTS.find((t) => t.id === tournamentId);

    const playersData = playersSnap.exists() ? playersSnap.val() as Record<string, { oddsDisplay?: string }> : {};

    // Build per-user pick lists with odds
    const userPicks: Record<string, { username: string; players: Array<{ name: string; odds: string }> }> = {};
    for (const user of users) {
      const myPicks = picks.filter((p) => p.userId === user.uid);
      if (myPicks.length === 0) continue;
      userPicks[user.uid] = {
        username: user.username,
        players: myPicks.map((p) => {
          const pd = playersData[p.playerId] ?? playersData[p.playerName];
          return { name: p.playerName, odds: pd?.oddsDisplay ?? 'N/A' };
        }),
      };
    }

    const totalTeams   = Object.keys(userPicks).length;
    const picksPerTeam = totalTeams > 0 ? picks.length / totalTeams : 0;
    const tournamentName = (tournament as { name?: string })?.name ?? tournamentId;

    if (totalTeams === 0) {
      return NextResponse.json({ error: 'No teams found with picks' }, { status: 400 });
    }

    const teamsBlock = Object.values(userPicks)
      .map(({ username, players }) =>
        `${username}:\n${players.map((p, i) => `  Pick ${i + 1}: ${p.name} (${p.odds})`).join('\n')}`
      ).join('\n\n');

    const prompt = `You are a snarky, hilarious golf analyst grading fantasy draft teams for a private group of friends in a ${tournamentName} draft league. Be funny, sarcastic, roast bad picks mercilessly — but keep it friendly and fun. You know golf well.

Scoring: Best 3 of ${Math.round(picksPerTeam)} drafted players count. Top 10 bonuses: ${TOP_10_POINTS.map((p, i) => `${i + 1}st: ${p}pts`).join(', ')}. Position 11+: points = finishing position (lower is better). Cut/WD = cut line + 1 points.

Teams (${totalTeams} total):

${teamsBlock}

For each team give:
1. A letter grade (A+, A, A-, B+, B, B-, C+, C, C-, D, F)
2. Win likelihood % — all ${totalTeams} teams must sum to exactly 100
3. A punchy 2-3 sentence paragraph: analyze picks, mention specific players, roast bad picks, genuinely assess their chances. Reference odds where relevant.

Respond ONLY with valid JSON array — no markdown, no backticks, no extra text:
[{"username":"...","grade":"B+","winPct":18,"summary":"..."}]`;

    const text = await callAI(prompt);

    let parsed: Array<{ username: string; grade: string; winPct: number; summary: string }>;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
      if (!Array.isArray(parsed)) throw new Error('Response is not an array');
    } catch {
      console.error('[draft-grades] JSON parse failed. Raw text:', text);
      return NextResponse.json({ error: 'AI returned invalid JSON', raw: text.slice(0, 200) }, { status: 500 });
    }

    // Merge with userIds
    const grades: DraftGrade[] = parsed.map((g) => {
      const user = users.find((u) => u.username === g.username);
      return {
        userId:      user?.uid ?? g.username,
        username:    g.username,
        grade:       g.grade,
        winPct:      g.winPct,
        summary:     g.summary,
        generatedAt: Date.now(),
      };
    });

    // Save via Admin SDK (bypasses ".write": false rule)
    const gradesMap: Record<string, DraftGrade> = {};
    for (const g of grades) gradesMap[g.userId] = g;
    await db.ref(`draftGrades/${tournamentId}`).set(gradesMap);

    // Push notify all users — fire and forget
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    pushToAllUsers(
      messaging, db,
      `🎓 Draft Report Cards — ${tournamentName}`,
      'AI draft grades are in. See how your team stacks up in Recaps.',
      `${appUrl}/recaps`,
    ).catch((e) => console.warn('[draft-grades] push failed:', e));

    return NextResponse.json({ grades, cached: false });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[draft-grades] Unhandled error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── GET — return cached grades ────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const tournamentId = req.nextUrl.searchParams.get('tournamentId');
  if (!tournamentId) return NextResponse.json({ error: 'Missing tournamentId' }, { status: 400 });

  const { db } = getAdminServices();
  const snap = await db.ref(`draftGrades/${tournamentId}`).get();
  if (!snap.exists()) return NextResponse.json({ grades: [] });
  return NextResponse.json({ grades: Object.values(snap.val() as Record<string, DraftGrade>), cached: true });
}
