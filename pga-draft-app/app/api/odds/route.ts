import { NextRequest, NextResponse } from 'next/server';
import {
  getOddsApiUrl,
  DRAFTKINGS_GOLF_URL,
  DRAFTKINGS_ALT_URL,
  parseOddsApiResponse,
  parseDraftKingsResponse,
  type OddsPlayer,
} from '@/lib/odds';

// ─── Server-side cache (survives across requests in same Vercel instance) ─────
interface CacheEntry { players: OddsPlayer[]; fetchedAt: number; source: string }
const oddsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — odds don't move that fast

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function tryFetch(url: string, label: string): Promise<{ data: unknown; source: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://sportsbook.draftkings.com/',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`[Odds] ${label} → ${res.status}`);
      return null;
    }
    const data = await res.json();
    return { data, source: label };
  } catch (e) {
    console.warn(`[Odds] ${label} error:`, e);
    return null;
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const tournamentName = req.nextUrl.searchParams.get('tournament') ?? 'pga';
  const bust = req.nextUrl.searchParams.get('bust') === '1';
  const cacheKey = tournamentName;

  // Serve from cache if fresh
  if (!bust) {
    const cached = oddsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json(
        { players: cached.players, source: cached.source, cached: true },
        { headers: { 'X-Cache': 'HIT', 'X-Source': cached.source } }
      );
    }
  }

  const apiKey = process.env.NEXT_PUBLIC_ODDS_API_KEY ?? process.env.ODDS_API_KEY ?? '';
  let players: OddsPlayer[] = [];
  let source = '';

  // ── Source 1: The Odds API (most reliable, free 500 req/mo) ──────────────
  if (apiKey) {
    const result = await tryFetch(getOddsApiUrl(apiKey), 'The Odds API');
    if (result) {
      try {
        const parsed = parseOddsApiResponse(result.data as Parameters<typeof parseOddsApiResponse>[0]);
        if (parsed.length > 5) {
          players = parsed;
          source = 'The Odds API';
        }
      } catch (e) {
        console.warn('[Odds] Odds API parse error:', e);
      }
    }
  }

  // ── Source 2: DraftKings public CDN ──────────────────────────────────────
  if (players.length === 0) {
    const result = await tryFetch(DRAFTKINGS_GOLF_URL, 'DraftKings');
    if (result) {
      try {
        const parsed = parseDraftKingsResponse(result.data as Parameters<typeof parseDraftKingsResponse>[0]);
        if (parsed.length > 5) {
          players = parsed;
          source = 'DraftKings';
        }
      } catch (e) {
        console.warn('[Odds] DraftKings parse error:', e);
      }
    }
  }

  // ── Source 3: DraftKings alternate endpoint ───────────────────────────────
  if (players.length === 0) {
    const result = await tryFetch(DRAFTKINGS_ALT_URL, 'DraftKings (alt)');
    if (result) {
      try {
        const parsed = parseDraftKingsResponse(result.data as Parameters<typeof parseDraftKingsResponse>[0]);
        if (parsed.length > 5) {
          players = parsed;
          source = 'DraftKings (alt)';
        }
      } catch (e) {
        console.warn('[Odds] DraftKings alt parse error:', e);
      }
    }
  }

  // ── Stale cache fallback ──────────────────────────────────────────────────
  if (players.length === 0) {
    const stale = oddsCache.get(cacheKey);
    if (stale) {
      return NextResponse.json(
        { players: stale.players, source: stale.source, cached: true, stale: true },
        { headers: { 'X-Cache': 'STALE', 'X-Source': stale.source } }
      );
    }
    return NextResponse.json(
      { error: 'No odds data available from any source.', players: [] },
      { status: 503 }
    );
  }

  // Cache and return
  oddsCache.set(cacheKey, { players, fetchedAt: Date.now(), source });
  return NextResponse.json(
    { players, source, cached: false },
    { headers: { 'X-Cache': 'MISS', 'X-Source': source } }
  );
}
