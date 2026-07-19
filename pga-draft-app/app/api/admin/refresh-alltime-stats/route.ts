import { NextRequest, NextResponse } from 'next/server';
import { getAdminServices } from '@/lib/fcm-admin';
import type { GolferAllTimeStats, SeasonArchive } from '@/lib/types';

export async function POST(_req: NextRequest) {
  try {
    const { db } = getAdminServices();

    // 1. Load all season archives
    const seasonsSnap = await db.ref('seasons').get();
    const archivedYears = new Set<number>();

    type PerfEntry = {
      playerName: string;
      year: number;
      tournamentId: string;
      tournamentName: string;
      draftedBy: string;
      pickNumber: number;
      points: number;
      positionDisplay: string;
    };
    const allPerfs: PerfEntry[] = [];

    if (seasonsSnap.exists()) {
      const seasons = seasonsSnap.val() as Record<string, SeasonArchive>;
      for (const [yearStr, archive] of Object.entries(seasons)) {
        const year = +yearStr;
        archivedYears.add(year);
        for (const gs of archive.golferStats ?? []) {
          for (const perf of gs.performances ?? []) {
            allPerfs.push({ ...perf, year, playerName: gs.playerName });
          }
        }
      }
    }

    // 2. Load all locked scores; compute perfs for non-archived years
    const lockedSnap = await db.ref('lockedScores').get();
    if (lockedSnap.exists()) {
      type LockedTs = {
        tournamentId: string; tournamentName: string; year: number;
        lockedAt: string; lockedBy: string;
        teamScores: { userId: string; username: string; top3Score: number; rank: number;
          players?: { playerName: string; points: number; countsInTop3: boolean; positionDisplay: string }[] }[];
      };
      const lockedData = lockedSnap.val() as Record<string, LockedTs>;
      const unarchived = Object.values(lockedData).filter(lt => !archivedYears.has(lt.year ?? 0));

      await Promise.all(unarchived.map(async (lt) => {
        const picksSnap = await db.ref(`drafts/${lt.tournamentId}/picks`).get();
        if (!picksSnap.exists()) return;
        const val = picksSnap.val();
        const picks = (Array.isArray(val) ? val : Object.values(val)) as {
          userId: string; username: string; playerName: string; pickNumber: number;
        }[];

        const scoreByUser: Record<string, Record<string, { points: number; positionDisplay: string }>> = {};
        for (const ts of lt.teamScores ?? []) {
          scoreByUser[ts.userId] = {};
          for (const ps of ts.players ?? []) {
            scoreByUser[ts.userId][ps.playerName] = { points: ps.points, positionDisplay: ps.positionDisplay ?? '-' };
          }
        }
        for (const pick of picks) {
          const score = scoreByUser[pick.userId]?.[pick.playerName];
          if (!score) continue;
          allPerfs.push({
            playerName: pick.playerName,
            year: lt.year ?? 0,
            tournamentId: lt.tournamentId,
            tournamentName: lt.tournamentName,
            draftedBy: pick.username,
            pickNumber: pick.pickNumber,
            points: score.points,
            positionDisplay: score.positionDisplay,
          });
        }
      }));
    }

    // 3. Aggregate per golfer
    type Acc = { playerName: string; timesDrafted: number; pickSpotSum: number; pointsSum: number; totalPoints: number; bestFinish: string; bestPositionNumeric: number; performances: PerfEntry[]; };
    const golferAcc: Record<string, Acc> = {};
    for (const perf of allPerfs) {
      if (!golferAcc[perf.playerName]) {
        golferAcc[perf.playerName] = { playerName: perf.playerName, timesDrafted: 0, pickSpotSum: 0, pointsSum: 0, totalPoints: 0, bestFinish: '-', bestPositionNumeric: 9999, performances: [] };
      }
      const g = golferAcc[perf.playerName];
      g.timesDrafted++;
      g.pickSpotSum += perf.pickNumber;
      g.pointsSum += perf.points;
      g.totalPoints += perf.points;
      const posNum = parseInt(perf.positionDisplay.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(posNum) && posNum < g.bestPositionNumeric) {
        g.bestPositionNumeric = posNum;
        g.bestFinish = perf.positionDisplay;
      }
      g.performances.push(perf);
    }

    // Firebase keys cannot contain . # $ [ ] / — sanitize player names
    const safeKey = (name: string) => name.replace(/[.#$[\]/]/g, '_');

    const now = Date.now();
    const allTimeStats: Record<string, GolferAllTimeStats> = {};
    for (const [name, acc] of Object.entries(golferAcc)) {
      allTimeStats[safeKey(name)] = {
        playerName: acc.playerName,
        timesDrafted: acc.timesDrafted,
        avgPickSpot: acc.timesDrafted > 0 ? Math.round((acc.pickSpotSum / acc.timesDrafted) * 10) / 10 : 0,
        totalPoints: acc.totalPoints,
        avgPoints: acc.timesDrafted > 0 ? Math.round((acc.pointsSum / acc.timesDrafted) * 10) / 10 : 0,
        bestFinish: acc.bestFinish,
        bestPositionNumeric: acc.bestPositionNumeric,
        lastUpdated: now,
        performances: acc.performances,
      };
    }

    await db.ref('allTimeGolferStats').set(allTimeStats);

    return NextResponse.json({ success: true, golfers: Object.keys(allTimeStats).length, performances: allPerfs.length });
  } catch (err) {
    console.error('[RefreshAlltimeStats]', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
