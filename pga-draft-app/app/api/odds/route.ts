import { NextRequest, NextResponse } from 'next/server';
import {
  getOddsApiUrl,
  DRAFTKINGS_URLS,
  parseOddsApiResponse,
  parseDraftKingsResponse,
  type OddsPlayer,
} from '@/lib/odds';
import { fetchLeaderboardRaw, parseLeaderboard } from '@/lib/espn';
import { TOURNAMENTS, STATIC_FIELDS } from '@/lib/constants';

// ─── Server-side cache ────────────────────────────────────────────────────────
interface CacheEntry { players: OddsPlayer[]; fetchedAt: number; source: string }
const oddsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function tryFetch(url: string, label: string): Promise<{ data: unknown; source: string } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://sportsbook.draftkings.com/',
        'Origin': 'https://sportsbook.draftkings.com',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`[Odds] ${label} → HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return { data, source: label };
  } catch (e) {
    console.warn(`[Odds] ${label} error:`, e);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const tournamentId = req.nextUrl.searchParams.get('tournament') ?? 'players-championship';
  const bust = req.nextUrl.searchParams.get('bust') === '1';

  // Serve fresh cache
  if (!bust) {
    const cached = oddsCache.get(tournamentId);
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

  // ── Source 1: The Odds API (needs key, most reliable) ────────────────────
  if (apiKey) {
    const result = await tryFetch(getOddsApiUrl(apiKey), 'The Odds API');
    if (result) {
      try {
        const parsed = parseOddsApiResponse(result.data as Parameters<typeof parseOddsApiResponse>[0]);
        if (parsed.length > 5) { players = parsed; source = 'The Odds API'; }
      } catch (e) { console.warn('[Odds] Odds API parse error:', e); }
    }
  }

  // ── Source 2: DraftKings — try all known URL patterns ────────────────────
  if (players.length === 0) {
    for (const url of DRAFTKINGS_URLS) {
      const result = await tryFetch(url, `DraftKings (${url.split('/').slice(-2).join('/')})`);
      if (result) {
        try {
          const parsed = parseDraftKingsResponse(
            result.data as Parameters<typeof parseDraftKingsResponse>[0],
            tournamentId
          );
          if (parsed.length > 5) {
            players = parsed;
            source = 'DraftKings';
            break;
          }
        } catch (e) { console.warn('[Odds] DK parse error:', e); }
      }
    }
  }

  // ── Source 3: ESPN field — guaranteed player list, no odds ────────────────
  // This runs if ALL odds sources fail. Gives player names for draft even without odds.
  if (players.length === 0) {
    const tournament = TOURNAMENTS.find((t) => t.id === tournamentId);
    const espnEventId = tournament?.espnEventId;
    if (espnEventId) {
      try {
        const result = await fetchLeaderboardRaw(espnEventId);
        if (result) {
          const { players: espnPlayers } = parseLeaderboard(result.data as never);
          const espnList = Object.values(espnPlayers);
          if (espnList.length > 5) {
            // Convert ESPN players to OddsPlayer format (no odds, just names)
            players = espnList.map((p) => ({
              id: p.id,
              name: p.name,
              espnName: p.name,
              americanOdds: 9999,
              impliedProb: 0,
              oddsDisplay: 'N/A',
              bookmaker: 'ESPN',
            }));
            source = 'ESPN Field (no odds available)';
          }
        }
      } catch (e) { console.warn('[Odds] ESPN field fallback error:', e); }
    }
  }

  // ── Source 4: Hardcoded static field (guaranteed — confirmed from official sources) ──
  if (players.length === 0) {
    const staticField = STATIC_FIELDS[tournamentId];
    if (staticField && staticField.length > 0) {
      players = staticField.map((name) => ({
        id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        name,
        espnName: name,
        americanOdds: 9999,
        impliedProb: 0,
        oddsDisplay: 'N/A',
        bookmaker: 'Field List',
      }));
      source = 'Static Field (no odds — APIs unavailable)';
    }
  }

  // ── Stale cache ────────────────────────────────────────────────────────────
  if (players.length === 0) {
    const stale = oddsCache.get(tournamentId);
    if (stale) {
      return NextResponse.json(
        { players: stale.players, source: stale.source, cached: true, stale: true },
        { headers: { 'X-Cache': 'STALE', 'X-Source': stale.source } }
      );
    }
    return NextResponse.json(
      { error: 'No player data available from any source', players: [] },
      { status: 503 }
    );
  }

  oddsCache.set(tournamentId, { players, fetchedAt: Date.now(), source });
  return NextResponse.json(
    { players, source, cached: false },
    { headers: { 'X-Cache': 'MISS', 'X-Source': source } }
  );
}
