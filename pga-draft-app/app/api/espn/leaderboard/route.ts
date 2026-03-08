import { NextRequest, NextResponse } from 'next/server';
import { fetchLeaderboardRaw } from '@/lib/espn';

// ─── In-memory server-side cache ──────────────────────────────────────────────
// Survives across requests within the same Vercel function instance.
// Acts as a fast first-line buffer before Firebase.

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
  source: string;
}

const memCache = new Map<string, CacheEntry>();
const MEM_CACHE_TTL_MS = 55_000; // 55 seconds — slightly under the 60s client poll

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const bustCache = req.nextUrl.searchParams.get('bust') === '1';

  if (!eventId) {
    return NextResponse.json({ error: 'Missing eventId' }, { status: 400 });
  }

  const now = Date.now();

  // 1. Return memory cache if fresh and not explicitly busted
  if (!bustCache) {
    const cached = memCache.get(eventId);
    if (cached && now - cached.fetchedAt < MEM_CACHE_TTL_MS) {
      return NextResponse.json(cached.data, {
        headers: {
          'X-Cache': 'HIT',
          'X-Cache-Source': cached.source,
          'X-Cache-Age': String(Math.floor((now - cached.fetchedAt) / 1000)),
        },
      });
    }
  }

  // 2. Try all ESPN endpoints in rotation
  const result = await fetchLeaderboardRaw(eventId);

  if (result) {
    // Store in memory cache
    memCache.set(eventId, {
      data: result.data,
      fetchedAt: now,
      source: result.source,
    });

    return NextResponse.json(result.data, {
      headers: {
        'X-Cache': 'MISS',
        'X-Cache-Source': result.source,
        'X-Fetched-At': new Date(now).toISOString(),
      },
    });
  }

  // 3. All live sources failed — return last known good data from memory cache
  const staleEntry = memCache.get(eventId);
  if (staleEntry) {
    console.warn(`[ESPN] All sources failed. Serving stale cache for event ${eventId} (age: ${Math.floor((now - staleEntry.fetchedAt) / 1000)}s)`);
    return NextResponse.json(staleEntry.data, {
      headers: {
        'X-Cache': 'STALE',
        'X-Cache-Source': staleEntry.source,
        'X-Cache-Age': String(Math.floor((now - staleEntry.fetchedAt) / 1000)),
        'X-Warning': 'All live sources failed — returning last known good data',
      },
    });
  }

  // 4. Nothing at all — return an error the client can handle gracefully
  return NextResponse.json(
    {
      error: 'All ESPN data sources are currently unavailable. Scores will resume updating automatically.',
      retryAfter: 30,
    },
    {
      status: 503,
      headers: { 'Retry-After': '30' },
    }
  );
}
