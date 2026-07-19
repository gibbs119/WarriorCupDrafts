import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices } from '@/lib/fcm-admin';
import type { GolferSeasonStats, UserSeasonStats, SeasonArchive } from '@/lib/types';

// Firebase may return arrays as keyed objects — normalize either shape to an array.
function asArray<T>(v: T[] | Record<string, T> | null | undefined): T[] {
  return Array.isArray(v) ? v : Object.values(v ?? {});
}

async function callAI(prompt: string): Promise<string> {
  // Try Anthropic first, fall back to OpenAI
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (anthropicKey) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.content?.[0]?.text;
    if (!text) throw new Error('Anthropic returned empty response');
    return text;
  }

  const openaiKey = process.env.OPENAI_API_KEY ?? '';
  if (openaiKey) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature: 0.9,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty response');
    return text;
  }

  throw new Error('No AI API key set — add ANTHROPIC_API_KEY or OPENAI_API_KEY to environment variables');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { year = 2026, lockedBy = 'admin', force = false, recapOnly = false } = body as {
      year?: number; lockedBy?: string; force?: boolean; recapOnly?: boolean;
    };

    const { db } = getAdminServices();

    // If recapOnly, reload existing archive, regenerate recap, and save
    if (recapOnly) {
      const archiveSnap = await db.ref(`seasons/${year}`).get();
      if (!archiveSnap.exists()) {
        return NextResponse.json({ error: 'No season archive found — run End Season first' }, { status: 404 });
      }
      const existing = archiveSnap.val() as SeasonArchive;
      try {
        const recap = await buildRecap(existing, year);
        await db.ref(`seasons/${year}/recap`).set(recap);
        await db.ref(`seasons/${year}/generatedAt`).set(Date.now());
        return NextResponse.json({ success: true, recap });
      } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
      }
    }

    // Guard: don't overwrite unless forced
    if (!force) {
      const existing = await db.ref(`seasons/${year}`).get();
      if (existing.exists()) {
        return NextResponse.json({ error: 'Season archive already exists. Pass force:true to overwrite.' }, { status: 409 });
      }
    }

    // ── 1. Load tournament IDs for this season from Firebase ───────────────────
    // Fall back to the 5 standard IDs if no year-tagged tournaments found
    const STANDARD_IDS = ['players-championship', 'masters', 'pga-championship', 'us-open', 'the-open'];
    let seasonTournIds: string[] = [];
    {
      const tSnap = await db.ref('tournaments').get();
      if (tSnap.exists()) {
        type TRow = { id: string; year?: number; sequence?: number };
        const all = Object.values(tSnap.val() as Record<string, TRow>);
        const forYear = all.filter(t => t.year === year).sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99));
        seasonTournIds = forYear.length > 0 ? forYear.map(t => t.id) : STANDARD_IDS;
      } else {
        seasonTournIds = STANDARD_IDS;
      }
    }

    // Build display labels from Firebase tournament names
    const tournLabels: Record<string, string> = {};
    const cutLineById: Record<string, number> = {};
    {
      await Promise.all(seasonTournIds.map(async (id) => {
        const snap = await db.ref(`tournaments/${id}`).get();
        const t = snap.exists() ? snap.val() as { name?: string; cutLine?: number } : null;
        tournLabels[id] = t?.name ?? id;
        if (typeof t?.cutLine === 'number') cutLineById[id] = t.cutLine;
      }));
    }
    // Unmatched / no-show golfers (points >= 9000) score as a missed cut, not the sentinel
    const fixPoints = (tournId: string, points: number) => points >= 9000 ? (cutLineById[tournId] ?? 65) + 1 : points;
    const fixDisplay = (points: number, display: string) => points >= 9000 && !/\d/.test(display ?? '') ? 'CUT' : (display ?? '-');

    // ── 2. Load all locked scores for this season ───────────────────────────────
    type LockedTs = {
      tournamentId: string; tournamentName: string; year: number;
      lockedAt: string; lockedBy: string;
      teamScores: { userId: string; username: string; top3Score: number; rank: number;
        players?: { playerName: string; points: number; countsInTop3: boolean; positionDisplay: string }[] }[];
    };
    const lockedScores: Record<string, LockedTs> = {};
    await Promise.all(seasonTournIds.map(async (id) => {
      const snap = await db.ref(`lockedScores/${id}`).get();
      if (snap.exists()) {
        const val = snap.val() as LockedTs;
        // Only include tournaments that belong to this season's year
        if (!val.year || val.year === year) {
          lockedScores[id] = val;
        }
      }
    }));

    const completedIds = seasonTournIds.filter(id => id in lockedScores);
    if (completedIds.length === 0) {
      return NextResponse.json({
        error: `No locked scores found for any ${year} tournament. Lock at least one tournament first.`,
      }, { status: 400 });
    }

    // ── 3. Load all draft picks ─────────────────────────────────────────────────
    type Pick = { userId: string; username: string; playerName: string; pickNumber: number };
    const draftPicks: Record<string, Pick[]> = {};
    await Promise.all(seasonTournIds.map(async (id) => {
      const snap = await db.ref(`drafts/${id}/picks`).get();
      if (snap.exists()) {
        const val = snap.val();
        draftPicks[id] = (Array.isArray(val) ? val : Object.values(val)) as Pick[];
      } else {
        draftPicks[id] = [];
      }
    }));

    // ── 4. Build season standings ───────────────────────────────────────────────
    const userTotals: Record<string, {
      userId: string; username: string;
      byTournament: Record<string, number>;
      total: number;
    }> = {};

    for (const [tournId, lt] of Object.entries(lockedScores)) {
      const teams = asArray(lt.teamScores);
      for (const ts of teams) {
        if (!ts || !ts.userId) continue;
        if (!userTotals[ts.userId]) {
          userTotals[ts.userId] = { userId: ts.userId, username: ts.username, byTournament: {}, total: 0 };
        }
        userTotals[ts.userId].byTournament[tournId] = ts.top3Score;
        userTotals[ts.userId].total += ts.top3Score;
      }
    }

    const seasonStandings = Object.values(userTotals)
      .sort((a, b) => a.total - b.total)
      .map((u, i) => ({ ...u, rank: i + 1 }));

    if (seasonStandings.length === 0) {
      return NextResponse.json({ error: 'No team scores found in locked data. Check that picks and scores are properly saved.' }, { status: 400 });
    }

    const champion = { ...seasonStandings[0] };

    // ── 5. Build golfer and user draft stats ────────────────────────────────────
    type GolferAcc = Omit<GolferSeasonStats, 'avgPickSpot' | 'avgPoints'> & { pickSpotSum: number; pointsSum: number };
    type UserAcc = Omit<UserSeasonStats, 'avgPointsPerPick'> & { pointsSum: number };

    const golferAcc: Record<string, GolferAcc> = {};
    const userAcc: Record<string, UserAcc> = {};

    for (const [tournId, lt] of Object.entries(lockedScores)) {
      const picks = draftPicks[tournId] ?? [];
      const teams = asArray(lt.teamScores);

      // Build per-user score lookup: userId → playerName → { points, positionDisplay }
      const scoreByUser: Record<string, Record<string, { points: number; positionDisplay: string }>> = {};
      for (const ts of teams) {
        if (!ts || !ts.userId) continue;
        scoreByUser[ts.userId] = {};
        const players = asArray(ts.players);
        for (const ps of players) {
          if (ps && ps.playerName) {
            scoreByUser[ts.userId][ps.playerName] = {
              points: fixPoints(tournId, ps.points),
              positionDisplay: fixDisplay(ps.points, ps.positionDisplay ?? '-'),
            };
          }
        }
      }

      const tournName = lt.tournamentName || tournLabels[tournId] || tournId;

      for (const pick of picks) {
        const score = scoreByUser[pick.userId]?.[pick.playerName];
        if (!score) continue;

        // ── Golfer stats ──
        if (!golferAcc[pick.playerName]) {
          golferAcc[pick.playerName] = {
            playerName: pick.playerName,
            timesDrafted: 0, pickSpotSum: 0, pointsSum: 0,
            totalPoints: 0, bestFinish: '-', bestPositionNumeric: 9999,
            performances: [],
          };
        }
        const g = golferAcc[pick.playerName];
        g.timesDrafted++;
        g.pickSpotSum += pick.pickNumber;
        g.pointsSum += score.points;
        g.totalPoints += score.points;

        const posNum = parseInt(score.positionDisplay.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(posNum) && posNum < g.bestPositionNumeric) {
          g.bestPositionNumeric = posNum;
          g.bestFinish = score.positionDisplay;
        }
        g.performances.push({
          tournamentId: tournId,
          tournamentName: tournName,
          draftedBy: pick.username,
          pickNumber: pick.pickNumber,
          points: score.points,
          positionDisplay: score.positionDisplay ?? '-',
        });

        // ── User draft stats ──
        if (!userAcc[pick.userId]) {
          userAcc[pick.userId] = {
            userId: pick.userId,
            username: pick.username,
            totalPicks: 0,
            pointsSum: 0,
            bestPick: { playerName: '', tournamentName: '', points: 99999, pickNumber: 0, positionDisplay: '-' },
            worstPick: { playerName: '', tournamentName: '', points: -99999, pickNumber: 0, positionDisplay: '-' },
            biggestSteal: { playerName: '', tournamentName: '', points: 99999, pickNumber: 0, positionDisplay: '-', valueScore: -Infinity },
          };
        }
        const u = userAcc[pick.userId];
        u.totalPicks++;
        u.pointsSum += score.points;

        if (score.points < u.bestPick.points) {
          u.bestPick = { playerName: pick.playerName, tournamentName: tournName, points: score.points, pickNumber: pick.pickNumber, positionDisplay: score.positionDisplay };
        }
        if (score.points > u.worstPick.points) {
          u.worstPick = { playerName: pick.playerName, tournamentName: tournName, points: score.points, pickNumber: pick.pickNumber, positionDisplay: score.positionDisplay };
        }
        const valueScore = -score.points + pick.pickNumber / 2;
        if (valueScore > u.biggestSteal.valueScore) {
          u.biggestSteal = { playerName: pick.playerName, tournamentName: tournName, points: score.points, pickNumber: pick.pickNumber, positionDisplay: score.positionDisplay, valueScore };
        }
      }
    }

    const golferStats: GolferSeasonStats[] = Object.values(golferAcc)
      .map(({ pickSpotSum, pointsSum, ...g }) => ({
        ...g,
        avgPickSpot: g.timesDrafted > 0 ? Math.round((pickSpotSum / g.timesDrafted) * 10) / 10 : 0,
        avgPoints: g.timesDrafted > 0 ? Math.round((pointsSum / g.timesDrafted) * 10) / 10 : 0,
      }))
      .sort((a, b) => a.totalPoints - b.totalPoints);

    const userDraftStats: UserSeasonStats[] = Object.values(userAcc)
      .map(({ pointsSum, ...u }) => ({
        ...u,
        avgPointsPerPick: u.totalPicks > 0 ? Math.round((pointsSum / u.totalPicks) * 10) / 10 : 0,
        bestPick: u.bestPick.playerName ? u.bestPick : { ...u.bestPick, playerName: '—' },
        worstPick: u.worstPick.playerName ? u.worstPick : { ...u.worstPick, playerName: '—' },
        biggestSteal: u.biggestSteal.playerName ? u.biggestSteal : { ...u.biggestSteal, playerName: '—' },
      }))
      .sort((a, b) => a.avgPointsPerPick - b.avgPointsPerPick);

    // ── 6. Build the archive object ─────────────────────────────────────────────
    const archive: SeasonArchive = {
      year,
      champion: { userId: champion.userId, username: champion.username, totalPoints: champion.total },
      seasonStandings: seasonStandings.map(({ byTournament, ...s }) => ({ ...s, byTournament })),
      golferStats,
      userDraftStats,
      recap: '',
      generatedAt: Date.now(),
      lockedBy,
    };

    // ── 7. Generate AI recap (non-fatal) ────────────────────────────────────────
    try {
      archive.recap = await buildRecap(archive, year);
    } catch (e) {
      console.warn('[EndSeason] AI recap failed:', e);
      archive.recap = '';
    }

    // ── 8. Save to Firebase ─────────────────────────────────────────────────────
    await db.ref(`seasons/${year}`).set(archive);

    return NextResponse.json({
      success: true,
      champion: archive.champion,
      standings: seasonStandings.length,
      golfers: golferStats.length,
      tournaments: completedIds.length,
      hasRecap: !!archive.recap,
    });
  } catch (err) {
    console.error('[EndSeason]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// ── AI recap builder ────────────────────────────────────────────────────────

async function buildRecap(archive: SeasonArchive, year = 2026): Promise<string> {
  const standingsText = archive.seasonStandings
    .map(s => `${s.rank}. ${s.username} — ${s.total > 0 ? '+' : ''}${s.total} pts`)
    .join('\n');

  const tourneyWinners = archive.seasonStandings[0]
    ? Object.keys(archive.seasonStandings[0].byTournament).map(id => {
        const scores = archive.seasonStandings.map(s => ({
          username: s.username,
          score: s.byTournament[id] ?? null,
        })).filter(x => x.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
        if (scores.length === 0) return null;
        const winner = scores[0];
        return `${id}: ${winner.username} (${winner.score! > 0 ? '+' : ''}${winner.score} pts)`;
      }).filter(Boolean).join('\n')
    : '';

  // Best/worst golfers judged by AVERAGE points (fair regardless of how many
  // times they were drafted). Lower points = better in this league.
  const rankedByAvg = [...archive.golferStats].sort((a, b) => a.avgPoints - b.avgPoints);
  const bestGolfer = rankedByAvg[0];
  const biggestBust = [...archive.golferStats]
    .filter(g => g.avgPickSpot > 0 && g.avgPickSpot <= 20)   // drafted reasonably early…
    .sort((a, b) => b.avgPoints - a.avgPoints)[0]             // …but scored the worst
    ?? [...archive.golferStats].sort((a, b) => b.avgPoints - a.avgPoints)[0];
  const bestSteal = archive.userDraftStats
    .map(u => u.biggestSteal)
    .filter(s => s.playerName && s.playerName !== '—')
    .sort((a, b) => b.valueScore - a.valueScore)[0];
  const mostDrafted = [...archive.golferStats].sort((a, b) => b.timesDrafted - a.timesDrafted)[0];

  const notableMoments = [
    bestGolfer ? `Best-value golfer: ${bestGolfer.playerName} averaged ${bestGolfer.avgPoints} pts across ${bestGolfer.timesDrafted} draft(s) — lowest is best` : null,
    bestSteal ? `Biggest steal: ${bestSteal.playerName} was pick #${bestSteal.pickNumber} (late) yet finished ${bestSteal.positionDisplay} for ${bestSteal.points} pts` : null,
    mostDrafted ? `Most drafted: ${mostDrafted.playerName} (${mostDrafted.timesDrafted}x, avg draft slot #${mostDrafted.avgPickSpot}, avg ${mostDrafted.avgPoints} pts)` : null,
    biggestBust ? `Biggest bust: ${biggestBust.playerName} was drafted around slot #${biggestBust.avgPickSpot} but averaged ${biggestBust.avgPoints} pts — brutal` : null,
  ].filter(Boolean).join('\n');

  const prompt = `You are the commissioner of a private golf fantasy draft league called "Warrior Cup." The ${year} major championship season just ended. Write a fun, punchy 3-4 paragraph season recap for the group chat. Casual, slightly trash-talking tone — like texting your buddies. No asterisks, no headers, no markdown — plain text only.

HOW WARRIOR CUP SCORING WORKS (critical — get this right):
- LOWER SCORES ARE BETTER. It's like golf — you want the fewest points.
- Each major, every manager drafts golfers, and only their BEST 3 golfers count that week.
- A golfer's points come from where they finish: 1st = -25, 2nd = -15, 3rd = -10, 4th = -8, 5th = -6, 6th = -5, 7th = -4, 8th = -3, 9th = -2, 10th = -1. Finishing 11th or worse = that finishing position as points (T15 = +15). Missing the cut / WD / DQ = roughly the cut line + 1 (a bad score in the +50 to +70 range).
- A manager's tournament score = the sum of their best 3 golfers' points. Lower = better.
- Season total = the sum of all tournament scores. The LOWEST season total wins the Warrior Cup.
- So a NEGATIVE season total is elite; a big positive total is bad. A "steal" is a golfer drafted late who scored very low (great value). A "bust" is a golfer drafted early who scored high (bad).

Never describe a high/positive score as good, and never say "scored the most points" as praise — that's a bad thing here.

SEASON CHAMPION: ${archive.champion.username} with ${archive.champion.totalPoints > 0 ? '+' : ''}${archive.champion.totalPoints} pts (lowest total wins)

FINAL SEASON STANDINGS (lower = better, rank 1 = champion):
${standingsText}

TOURNAMENT-BY-TOURNAMENT WINNERS (lowest score each major):
${tourneyWinners}

NOTABLE MOMENTS:
${notableMoments}

Write the recap now — accurate to the scoring above. Congratulate the champion, roast whoever finished last (highest total), and call out the biggest steal and bust.`;

  return callAI(prompt);
}
