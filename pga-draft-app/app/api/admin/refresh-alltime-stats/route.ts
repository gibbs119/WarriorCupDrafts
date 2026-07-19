import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices } from '@/lib/fcm-admin';
import { STANDARD_TOURNAMENTS } from '@/lib/constants';
import type { GolferAllTimeStats, SeasonArchive, ManagerAllTimeStats, AllTimeTeamData } from '@/lib/types';

const SENTINEL = 9000;        // points >= this = unmatched / no-show (9999) or DQ (99999)
const MISSED_CUT_RANK = 60;   // nominal finishing rank used for slot math when cut/no-show

// Firebase may return arrays as keyed objects — normalize either shape to an array.
function asArray<T>(v: T[] | Record<string, T> | null | undefined): T[] {
  return Array.isArray(v) ? v : Object.values(v ?? {});
}

const STD_LABELS: Record<string, string> = {
  'players-championship': 'The Players Championship',
  'masters': 'The Masters',
  'pga-championship': 'PGA Championship',
  'us-open': 'U.S. Open',
  'the-open': 'The Open Championship',
};

function finishRankOf(positionDisplay: string, fixedPoints: number): number {
  if (fixedPoints >= SENTINEL) return MISSED_CUT_RANK;
  const digits = (positionDisplay ?? '').replace(/[^0-9]/g, '');
  const n = parseInt(digits, 10);
  if (!isNaN(n) && n > 0) return n;
  // CUT / WD / DQ / '-' with no digits
  return MISSED_CUT_RANK;
}

export async function POST(_req: NextRequest) {
  try {
    const { db } = getAdminServices();

    // ── Load tournament cut lines (tournamentId → cutLine) for the sentinel fix ──
    const cutLineById: Record<string, number> = {};
    const nameById: Record<string, string> = { ...STD_LABELS };
    for (const st of STANDARD_TOURNAMENTS) { cutLineById[st.id] = st.cutLine; nameById[st.id] = st.name; }
    const tSnap = await db.ref('tournaments').get();
    if (tSnap.exists()) {
      const trows = tSnap.val() as Record<string, { id?: string; cutLine?: number; name?: string }>;
      for (const [key, t] of Object.entries(trows)) {
        const id = t.id ?? key;
        if (typeof t.cutLine === 'number') cutLineById[id] = t.cutLine;
        if (t.name) nameById[id] = t.name;
      }
    }
    const cutOf = (tournamentId: string) => cutLineById[tournamentId] ?? 65;

    // ── 1. Collect golfer performances from all sources ─────────────────────────
    type PerfEntry = {
      playerName: string;
      year: number;
      tournamentId: string;
      tournamentName: string;
      draftedBy: string;       // username
      pickNumber: number;
      points: number;          // sentinel-fixed
      positionDisplay: string; // sentinel-fixed
      finishRank: number;
    };
    const allPerfs: PerfEntry[] = [];
    const archivedYears = new Set<number>();

    const diag: {
      archivedSeasons: number;
      lockedTournaments: number;
      unarchivedTournaments: number;
      tournamentsWithoutPicks: string[];
      matchedPerformances: Record<string, string>;
      sentinelFixed: number;
    } = {
      archivedSeasons: 0, lockedTournaments: 0, unarchivedTournaments: 0,
      tournamentsWithoutPicks: [], matchedPerformances: {}, sentinelFixed: 0,
    };

    const pushPerf = (raw: Omit<PerfEntry, 'points' | 'positionDisplay' | 'finishRank'> & { points: number; positionDisplay: string }) => {
      let points = raw.points;
      let positionDisplay = raw.positionDisplay ?? '-';
      if (points >= SENTINEL) {
        points = cutOf(raw.tournamentId) + 1;           // treat no-show / unmatched as a missed cut
        if (!/\d/.test(positionDisplay)) positionDisplay = 'CUT';
        diag.sentinelFixed++;
      }
      allPerfs.push({ ...raw, points, positionDisplay, finishRank: finishRankOf(positionDisplay, points) });
    };

    // ── Season-level standings, collected per year for manager aggregation ───────
    type SeasonStanding = { username: string; total: number; rank: number; byTournament: Record<string, number> };
    const seasonBlocks: { year: number; champion: string | null; standings: SeasonStanding[]; final: boolean }[] = [];
    // Per-tournament team scores: for tournament records + "wins"
    const tournTeamScores: { username: string; tournamentId: string; year: number; top3Score: number }[] = [];

    // ── 1a. Archived seasons ─────────────────────────────────────────────────────
    const seasonsSnap = await db.ref('seasons').get();
    if (seasonsSnap.exists()) {
      const seasons = seasonsSnap.val() as Record<string, SeasonArchive>;
      diag.archivedSeasons = Object.keys(seasons).length;
      for (const [yearStr, archive] of Object.entries(seasons)) {
        const year = +yearStr;
        archivedYears.add(year);

        const golferStats = asArray(archive.golferStats);
        for (const gs of golferStats) {
          if (!gs || !gs.playerName) continue;
          const perfs = asArray(gs.performances);
          for (const perf of perfs) {
            pushPerf({
              playerName: gs.playerName, year,
              tournamentId: perf.tournamentId, tournamentName: perf.tournamentName ?? nameById[perf.tournamentId] ?? perf.tournamentId,
              draftedBy: perf.draftedBy, pickNumber: perf.pickNumber,
              points: perf.points, positionDisplay: perf.positionDisplay ?? '-',
            });
          }
        }

        const standings = asArray(archive.seasonStandings)
          .filter(Boolean)
          .map(s => ({ username: s.username, total: s.total, rank: s.rank, byTournament: s.byTournament ?? {} }));
        seasonBlocks.push({ year, champion: archive.champion?.username ?? null, standings, final: true });

        for (const s of standings) {
          for (const [tid, score] of Object.entries(s.byTournament ?? {})) {
            if (typeof score === 'number') tournTeamScores.push({ username: s.username, tournamentId: tid, year, top3Score: score });
          }
        }
      }
    }

    // ── 1b. Locked scores (current / unarchived seasons) ─────────────────────────
    type LockedTs = {
      tournamentId: string; tournamentName: string; year: number;
      teamScores: { userId: string; username: string; top3Score: number; rank: number;
        players?: { playerName: string; points: number; positionDisplay: string }[] }[];
    };
    const lockedSnap = await db.ref('lockedScores').get();
    // year → username → { total, byTournament }
    const currentStandings: Record<number, Record<string, { total: number; byTournament: Record<string, number> }>> = {};
    if (lockedSnap.exists()) {
      const lockedData = lockedSnap.val() as Record<string, LockedTs>;
      const entries = Object.values(lockedData).filter(Boolean);
      diag.lockedTournaments = entries.length;
      const unarchived = entries.filter(lt => !archivedYears.has(lt.year ?? 0));
      diag.unarchivedTournaments = unarchived.length;

      await Promise.all(unarchived.map(async (lt) => {
        const teams = asArray(lt.teamScores);
        const year = lt.year ?? 0;

        // Season standings accumulation + tournament records
        for (const ts of teams) {
          if (!ts || !ts.username) continue;
          (currentStandings[year] ??= {});
          const rec = (currentStandings[year][ts.username] ??= { total: 0, byTournament: {} });
          rec.total += ts.top3Score;
          rec.byTournament[lt.tournamentId] = ts.top3Score;
          tournTeamScores.push({ username: ts.username, tournamentId: lt.tournamentId, year, top3Score: ts.top3Score });
        }

        // Golfer performances (need draft picks for pick numbers)
        const picksSnap = await db.ref(`drafts/${lt.tournamentId}/picks`).get();
        if (!picksSnap.exists()) { diag.tournamentsWithoutPicks.push(lt.tournamentId); return; }
        const pval = picksSnap.val();
        const picks = (Array.isArray(pval) ? pval : Object.values(pval ?? {})) as {
          userId: string; username: string; playerName: string; pickNumber: number;
        }[];

        const scoreByUser: Record<string, Record<string, { points: number; positionDisplay: string }>> = {};
        for (const ts of teams) {
          if (!ts || !ts.userId) continue;
          scoreByUser[ts.userId] = {};
          const players = asArray(ts.players);
          for (const ps of players) {
            if (ps && ps.playerName) scoreByUser[ts.userId][ps.playerName] = { points: ps.points, positionDisplay: ps.positionDisplay ?? '-' };
          }
        }

        let matched = 0;
        for (const pick of picks) {
          if (!pick || !pick.playerName) continue;
          const score = scoreByUser[pick.userId]?.[pick.playerName];
          if (!score) continue;
          matched++;
          pushPerf({
            playerName: pick.playerName, year,
            tournamentId: lt.tournamentId, tournamentName: lt.tournamentName ?? nameById[lt.tournamentId] ?? lt.tournamentId,
            draftedBy: pick.username, pickNumber: pick.pickNumber,
            points: score.points, positionDisplay: score.positionDisplay ?? '-',
          });
        }
        diag.matchedPerformances[lt.tournamentId] = `${matched}/${picks.length}`;
      }));

      // Rank current-season standings and add as non-final season blocks
      for (const [yearStr, byUser] of Object.entries(currentStandings)) {
        const year = +yearStr;
        const standings = Object.entries(byUser)
          .map(([username, r]) => ({ username, total: r.total, byTournament: r.byTournament, rank: 0 }))
          .sort((a, b) => a.total - b.total)
          .map((s, i) => ({ ...s, rank: i + 1 }));
        seasonBlocks.push({ year, champion: null, standings, final: false }); // not final → no title
      }
    }

    // ── 2. Aggregate golfers ─────────────────────────────────────────────────────
    type GAcc = { playerName: string; timesDrafted: number; pickSpotSum: number; pointsSum: number; totalPoints: number;
      bestFinish: string; bestPositionNumeric: number; slotSum: number; finishSum: number; performances: PerfEntry[]; };
    const golferAcc: Record<string, GAcc> = {};
    for (const perf of allPerfs) {
      const g = (golferAcc[perf.playerName] ??= { playerName: perf.playerName, timesDrafted: 0, pickSpotSum: 0, pointsSum: 0,
        totalPoints: 0, bestFinish: '-', bestPositionNumeric: 9999, slotSum: 0, finishSum: 0, performances: [] });
      g.timesDrafted++;
      g.pickSpotSum += perf.pickNumber;
      g.pointsSum += perf.points;
      g.totalPoints += perf.points;
      g.slotSum += (perf.pickNumber - perf.finishRank);
      g.finishSum += perf.finishRank;
      const posNum = parseInt((perf.positionDisplay ?? '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(posNum) && posNum > 0 && posNum < g.bestPositionNumeric) {
        g.bestPositionNumeric = posNum;
        g.bestFinish = perf.positionDisplay;
      }
      g.performances.push(perf);
    }

    const safeKey = (name: string) => name.replace(/[.#$[\]/]/g, '_');
    const now = Date.now();
    const round1 = (n: number) => Math.round(n * 10) / 10;

    const allTimeStats: Record<string, GolferAllTimeStats> = {};
    for (const [name, acc] of Object.entries(golferAcc)) {
      allTimeStats[safeKey(name)] = {
        playerName: acc.playerName,
        timesDrafted: acc.timesDrafted,
        avgPickSpot: acc.timesDrafted > 0 ? round1(acc.pickSpotSum / acc.timesDrafted) : 0,
        totalPoints: acc.totalPoints,
        avgPoints: acc.timesDrafted > 0 ? round1(acc.pointsSum / acc.timesDrafted) : 0,
        bestFinish: acc.bestFinish,
        bestPositionNumeric: acc.bestPositionNumeric,
        slotPerformance: acc.timesDrafted > 0 ? round1(acc.slotSum / acc.timesDrafted) : 0,
        avgFinishRank: acc.timesDrafted > 0 ? round1(acc.finishSum / acc.timesDrafted) : 0,
        lastUpdated: now,
        performances: acc.performances.map(({ finishRank, ...p }) => p),  // strip helper field
      };
    }

    // ── 3. Aggregate managers ────────────────────────────────────────────────────
    // 3a. Per-tournament winners (lowest top3Score per tournament+year)
    const bestByTournYear: Record<string, { min: number; winners: string[] }> = {};
    for (const t of tournTeamScores) {
      const k = `${t.tournamentId}|${t.year}`;
      const cur = bestByTournYear[k];
      if (!cur || t.top3Score < cur.min) bestByTournYear[k] = { min: t.top3Score, winners: [t.username] };
      else if (t.top3Score === cur.min) cur.winners.push(t.username);
    }

    type MAcc = ManagerAllTimeStats & { _rankSum: number };
    const mgrAcc: Record<string, MAcc> = {};
    const ensureMgr = (username: string): MAcc => (mgrAcc[username] ??= {
      userId: username, username, titles: 0, seasonsPlayed: 0, careerPoints: 0, avgSeasonFinish: 0,
      bestSeason: null, worstSeason: null, tournamentRecords: {}, totalPicks: 0, slotSkill: 0,
      mostDrafted: [], bestSteal: null, worstBust: null, _rankSum: 0,
    });

    // Season standings → titles, career points, finishes, best/worst season
    for (const block of seasonBlocks) {
      for (const s of block.standings) {
        const m = ensureMgr(s.username);
        m.seasonsPlayed++;
        m.careerPoints += s.total;
        m._rankSum += s.rank;
        if (block.final && block.champion === s.username) m.titles++;
        if (!m.bestSeason || s.rank < m.bestSeason.rank) m.bestSeason = { year: block.year, rank: s.rank, points: s.total };
        if (!m.worstSeason || s.rank > m.worstSeason.rank) m.worstSeason = { year: block.year, rank: s.rank, points: s.total };
      }
    }

    // Tournament records
    for (const t of tournTeamScores) {
      const m = ensureMgr(t.username);
      const rec = (m.tournamentRecords[t.tournamentId] ??= {
        tournamentName: nameById[t.tournamentId] ?? t.tournamentId, count: 0, best: Infinity, worst: -Infinity, avg: 0, wins: 0,
      });
      rec.count++;
      rec.best = Math.min(rec.best, t.top3Score);
      rec.worst = Math.max(rec.worst, t.top3Score);
      rec.avg += t.top3Score;
      const winners = bestByTournYear[`${t.tournamentId}|${t.year}`]?.winners ?? [];
      if (winners.includes(t.username)) rec.wins++;
    }

    // Draft tendencies from performances
    const draftCount: Record<string, Record<string, number>> = {};   // username → player → count
    const slotAgg: Record<string, { sum: number; n: number }> = {};  // username → slot delta
    for (const perf of allPerfs) {
      const m = ensureMgr(perf.draftedBy);
      m.totalPicks++;
      (draftCount[perf.draftedBy] ??= {});
      draftCount[perf.draftedBy][perf.playerName] = (draftCount[perf.draftedBy][perf.playerName] ?? 0) + 1;
      const delta = perf.pickNumber - perf.finishRank;
      (slotAgg[perf.draftedBy] ??= { sum: 0, n: 0 });
      slotAgg[perf.draftedBy].sum += delta;
      slotAgg[perf.draftedBy].n++;
      const asPick = { playerName: perf.playerName, year: perf.year, tournamentName: perf.tournamentName, pickNumber: perf.pickNumber, positionDisplay: perf.positionDisplay, points: perf.points };
      if (!m.bestSteal || delta > (m.bestSteal.pickNumber - finishRankOf(m.bestSteal.positionDisplay, m.bestSteal.points))) m.bestSteal = asPick;
      if (!m.worstBust || delta < (m.worstBust.pickNumber - finishRankOf(m.worstBust.positionDisplay, m.worstBust.points))) m.worstBust = asPick;
    }

    for (const [username, m] of Object.entries(mgrAcc)) {
      m.avgSeasonFinish = m.seasonsPlayed > 0 ? round1(m._rankSum / m.seasonsPlayed) : 0;
      for (const rec of Object.values(m.tournamentRecords)) rec.avg = rec.count > 0 ? round1(rec.avg / rec.count) : 0;
      m.slotSkill = slotAgg[username]?.n ? round1(slotAgg[username].sum / slotAgg[username].n) : 0;
      m.mostDrafted = Object.entries(draftCount[username] ?? {})
        .map(([playerName, count]) => ({ playerName, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    }

    // Head-to-head: for each pair, count seasons one finished above the other
    const h2h: AllTimeTeamData['headToHead'] = {};
    for (const block of seasonBlocks) {
      const st = block.standings;
      for (let i = 0; i < st.length; i++) {
        for (let j = i + 1; j < st.length; j++) {
          const [a, b] = [st[i].username, st[j].username].sort();
          const key = `${a}|${b}`;
          const rec = (h2h[key] ??= { a, b, aWins: 0, bWins: 0, seasons: 0 });
          const aRank = st.find(s => s.username === a)!.rank;
          const bRank = st.find(s => s.username === b)!.rank;
          rec.seasons++;
          if (aRank < bRank) rec.aWins++; else if (bRank < aRank) rec.bWins++;
        }
      }
    }

    const managers: ManagerAllTimeStats[] = Object.values(mgrAcc)
      .map(({ _rankSum, ...m }) => m)
      .sort((a, b) => (b.titles - a.titles) || (a.avgSeasonFinish - b.avgSeasonFinish));

    const teamData: AllTimeTeamData = { managers, headToHead: h2h, lastUpdated: now };

    // ── 4. Persist ───────────────────────────────────────────────────────────────
    await db.ref('allTimeGolferStats').set(allTimeStats);
    await db.ref('allTimeTeamData').set(teamData);

    return NextResponse.json({
      success: true,
      golfers: Object.keys(allTimeStats).length,
      managers: managers.length,
      performances: allPerfs.length,
      diag,
    });
  } catch (err) {
    console.error('[RefreshAlltimeStats]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
