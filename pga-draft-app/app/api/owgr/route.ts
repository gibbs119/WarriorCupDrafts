import { NextResponse } from 'next/server';
import { fetchOwgrRankings, type OwgrEntry } from '@/lib/owgr';

// ─── Server-side cache ────────────────────────────────────────────────────────
// Rankings update weekly — 24h TTL is more than sufficient.
interface CacheEntry { entries: OwgrEntry[]; fetchedAt: number }
let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function GET(req: Request) {
  const bust = new URL(req.url).searchParams.get('bust') === '1';

  if (!bust && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json(
      { entries: cache.entries, fetchedAt: cache.fetchedAt, cached: true },
      { headers: { 'X-Cache': 'HIT' } }
    );
  }

  const entries = await fetchOwgrRankings();

  if (!entries || entries.length === 0) {
    if (cache) {
      return NextResponse.json(
        { entries: cache.entries, fetchedAt: cache.fetchedAt, cached: true, stale: true },
        { headers: { 'X-Cache': 'STALE' } }
      );
    }
    return NextResponse.json(
      { error: 'OWGR data unavailable', entries: [] },
      { status: 503 }
    );
  }

  cache = { entries, fetchedAt: Date.now() };
  return NextResponse.json(
    { entries, fetchedAt: cache.fetchedAt, cached: false },
    { headers: { 'X-Cache': 'MISS' } }
  );
}
