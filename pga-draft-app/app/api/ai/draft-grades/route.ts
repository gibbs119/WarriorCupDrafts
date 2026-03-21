import { NextRequest, NextResponse } from 'next/server';
import { ref, get, set } from 'firebase/database';
import { db } from '@/lib/firebase';
import { TOURNAMENTS, TOP_10_POINTS } from '@/lib/constants';

// Generates AI draft grades for all teams and caches them in Firebase.
// Called once after the draft completes; cached forever (grades don't change).
// Uses Google Gemini API (free tier — https://aistudio.google.com/app/apikey)

export interface DraftGrade {
  userId: string;
  username: string;
  grade: string;          // e.g. "A-"
  winPct: number;         // 0-100 likelihood of winning
  summary: string;        // 2-3 sentence roast+analysis paragraph
  generatedAt: number;
}

// ── Google Gemini free API ────────────────────────────────────────────────────
async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? '';
  if (!apiKey) {
    console.error('[draft-grades] GEMINI_API_KEY not set');
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2000, temperature: 0.9 },
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[draft-grades] Gemini error:', res.status, err);
      return null;
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (e) {
    console.error('[draft-grades] Gemini fetch error:', e);
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { tournamentId, force } = await req.json();
    if (!tournamentId) return NextResponse.json({ error: 'Missing tournamentId' }, { status: 400 });

    // Return cached grades if they exist (unless force=true)
    if (!force) {
      const cached = await get(ref(db, `draftGrades/${tournamentId}`));
      if (cached.exists()) {
        return NextResponse.json({ grades: Object.values(cached.val()), cached: true });
      }
    }

    // Load everything we need
    const [draftSnap, usersSnap, tournamentSnap] = await Promise.all([
      get(ref(db, `drafts/${tournamentId}`)),
      get(ref(db, 'users')),
      get(ref(db, `tournaments/${tournamentId}`)),
    ]);

    if (!draftSnap.exists()) return NextResponse.json({ error: 'No draft found' }, { status: 404 });

    const draftState = draftSnap.val();
    const users = usersSnap.exists() ? Object.values(usersSnap.val()) as Array<{ uid: string; username: string }> : [];
    const tournament = tournamentSnap.exists() ? tournamentSnap.val() : TOURNAMENTS.find((t) => t.id === tournamentId);

    // Load static odds for context
    const staticOddsSnap = await get(ref(db, `players/${tournamentId}`));
    const playersData = staticOddsSnap.exists() ? staticOddsSnap.val() : {};

    // Build per-user pick lists with odds context
    const picks = draftState.picks ?? [];
    const userPicks: Record<string, { username: string; players: Array<{ name: string; odds: string }> }> = {};

    for (const user of users) {
      const myPicks = picks.filter((p: { userId: string }) => p.userId === user.uid);
      if (myPicks.length === 0) continue;
      userPicks[user.uid] = {
        username: user.username,
        players: myPicks.map((p: { playerName: string; playerId: string }) => {
          const playerData = playersData[p.playerId] ?? playersData[p.playerName];
          const odds = playerData?.oddsDisplay ?? 'N/A';
          return { name: p.playerName, odds };
        }),
      };
    }

    const tournamentName = tournament?.name ?? tournamentId;
    const totalTeams = Object.keys(userPicks).length;
    const picksPerTeam = picks.length / Math.max(totalTeams, 1);

    const teamsBlock = Object.values(userPicks).map(({ username, players }) =>
      `${username}:\n${players.map((p, i) => `  Pick ${i + 1}: ${p.name} (${p.odds})`).join('\n')}`
    ).join('\n\n');

    const prompt = `You are a snarky, hilarious golf analyst grading fantasy draft teams for a group of friends in a ${tournamentName} draft league. Be funny, sarcastic, and roast bad picks mercilessly — but keep it friendly and fun. You know golf well.

Scoring system: Best 3 of ${picksPerTeam} drafted players count. Top 10 bonuses: ${TOP_10_POINTS.map((p, i) => `${i + 1}st: ${p}`).join(', ')}. Position 11+: points = finishing position (lower is better). Cut/WD = cut line + 1 points.

Here are the ${totalTeams} teams:

${teamsBlock}

For each team, give:
1. A letter grade (A+, A, A-, B+, B, B-, C+, C, C-, D, F)
2. A win likelihood percentage (all ${totalTeams} teams must add up to 100%)
3. A 2-3 sentence paragraph that analyzes their picks, mentions specific players, roasts them if warranted, but also genuinely assesses their chances. Reference the odds where relevant. Be snarky but accurate.

Respond ONLY with valid JSON — no markdown, no backticks, no extra text:
[
  {
    "username": "...",
    "grade": "B+",
    "winPct": 18,
    "summary": "..."
  }
]`;

    const text = await callGemini(prompt);
    if (!text) {
      return NextResponse.json({
        error: 'AI generation failed — check GEMINI_API_KEY env variable. Get a free key at https://aistudio.google.com/app/apikey',
      }, { status: 500 });
    }

    let parsed: Array<{ username: string; grade: string; winPct: number; summary: string }>;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error('[draft-grades] JSON parse failed:', text);
      return NextResponse.json({ error: 'AI returned invalid JSON' }, { status: 500 });
    }

    // Merge with userIds and save to Firebase
    const grades: DraftGrade[] = parsed.map((g) => {
      const user = users.find((u) => u.username === g.username);
      return {
        userId: user?.uid ?? g.username,
        username: g.username,
        grade: g.grade,
        winPct: g.winPct,
        summary: g.summary,
        generatedAt: Date.now(),
      };
    });

    // Cache in Firebase keyed by username
    const gradesMap: Record<string, DraftGrade> = {};
    for (const g of grades) {
      gradesMap[g.userId] = g;
    }
    await set(ref(db, `draftGrades/${tournamentId}`), gradesMap);

    return NextResponse.json({ grades, cached: false });
  } catch (err) {
    console.error('[draft-grades]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const tournamentId = req.nextUrl.searchParams.get('tournamentId');
  if (!tournamentId) return NextResponse.json({ error: 'Missing tournamentId' }, { status: 400 });

  const snap = await get(ref(db, `draftGrades/${tournamentId}`));
  if (!snap.exists()) return NextResponse.json({ grades: [] });

  return NextResponse.json({ grades: Object.values(snap.val()), cached: true });
}
