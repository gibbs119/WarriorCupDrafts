import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import HISTORICAL_DATA from '@/historical_clean.json';

function getAdminDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_ADMIN_PROJECT_ID!,
        clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL!,
        privateKey:  process.env.FIREBASE_ADMIN_PRIVATE_KEY!.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
    });
  }
  return getDatabase();
}

interface HistoricalRecord {
  id: string;
  tournamentId: string;
  name: string;
  year: number;
  users: string[];
  picks: Record<string, string[]>;
  picksPerUser: number;
  playerScores?: Record<string, Record<string, number>>; // username → golfer → position
  hasScores: boolean;
}

export async function POST(req: NextRequest) {
  // Simple guard: require the internal CRON_SECRET or skip check in dev
  const secret = req.headers.get('x-admin-secret');
  const expected = process.env.CRON_SECRET;
  if (expected && secret !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getAdminDb();
  const { overwrite = false } = await req.json().catch(() => ({}));
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const record of HISTORICAL_DATA as HistoricalRecord[]) {
    const key = record.id;
    try {
      if (!overwrite) {
        const existing = await db.ref(`historicalDrafts/${key}`).get();
        if (existing.exists()) { skipped.push(key); continue; }
      }

      // Convert picks into a display-friendly structure
      const picksByUser: Record<string, { username: string; picks: { playerName: string; pickNumber: number }[] }> = {};
      let globalPick = 0;
      for (const [username, golfers] of Object.entries(record.picks)) {
        picksByUser[username] = {
          username,
          picks: (golfers as string[]).map((name) => ({
            playerName: name,
            pickNumber: ++globalPick,
          })),
        };
      }

      await db.ref(`historicalDrafts/${key}`).set({
        id: key,
        tournamentId: record.tournamentId,
        tournamentName: record.name,
        year: record.year,
        users: record.users,
        picksPerUser: record.picksPerUser,
        picksByUser,
        playerScores: record.playerScores ?? null,
        hasScores: record.hasScores,
        locked: true,
        isHistorical: true,
        importedAt: new Date().toISOString(),
      });

      imported.push(key);
    } catch (err) {
      errors.push(`${key}: ${err}`);
    }
  }

  return NextResponse.json({
    success: true,
    total: HISTORICAL_DATA.length,
    imported: imported.length,
    skipped: skipped.length,
    errors,
  });
}
