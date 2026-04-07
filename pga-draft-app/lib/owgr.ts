// ─── Official World Golf Ranking (OWGR) ──────────────────────────────────────
// Fetches current rankings from owgr.com public API.
// No API key required — uses browser-like headers to avoid bot detection.
// Rankings update weekly (Monday after a tour event finishes).

import { playerKey } from './odds';

export interface OwgrEntry {
  rank: number;
  name: string;       // display name as returned by OWGR
  key: string;        // normalized playerKey for matching
}

// ─── OWGR.com public API ──────────────────────────────────────────────────────
// Fetches up to 500 players per page. Top 500 covers all competitive players.
const OWGR_URL =
  'https://www.owgr.com/api/ranking?pageNo=1&pageSize=500&countryCode=&playerName=';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.owgr.com/ranking',
  Origin: 'https://www.owgr.com',
};

// ─── Parse OWGR API response ──────────────────────────────────────────────────
// Handles the owgr.com API shape (and gracefully ignores unknown shapes).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOwgrResponse(data: any): OwgrEntry[] {
  const entries: OwgrEntry[] = [];

  // Shape 1: { playerRankings: [ { currentRank, firstName, lastName, ... } ] }
  const list =
    data?.playerRankings ??
    data?.rankings ??
    data?.players ??
    (Array.isArray(data) ? data : null);

  if (!Array.isArray(list)) return entries;

  for (const item of list) {
    const rank =
      item.currentRank ?? item.rank ?? item.rankingPosition ?? item.position;
    const name =
      item.name ??
      item.playerName ??
      (item.firstName && item.lastName
        ? `${item.firstName} ${item.lastName}`
        : null);

    if (!rank || !name || typeof rank !== 'number') continue;

    entries.push({ rank, name, key: playerKey(name) });
  }

  return entries;
}

// ─── Fetch live rankings ──────────────────────────────────────────────────────
export async function fetchOwgrRankings(): Promise<OwgrEntry[] | null> {
  try {
    const res = await fetch(OWGR_URL, {
      headers: BROWSER_HEADERS,
      cache: 'no-store',
    });

    if (!res.ok) {
      console.warn(`[OWGR] API returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const entries = parseOwgrResponse(data);

    if (entries.length < 10) {
      console.warn(`[OWGR] Parsed too few entries (${entries.length}) — response may have changed shape`);
      return null;
    }

    console.log(`[OWGR] Fetched ${entries.length} rankings`);
    return entries;
  } catch (e) {
    console.warn('[OWGR] Fetch error:', e);
    return null;
  }
}

// ─── Build lookup map: playerKey → rank ──────────────────────────────────────
export function buildOwgrLookup(entries: OwgrEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    map.set(e.key, e.rank);
  }
  return map;
}
