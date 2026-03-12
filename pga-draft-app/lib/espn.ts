import type { Player } from './types';

// ─── All known free ESPN/PGA endpoint patterns ───────────────────────────────
// Rotated on each attempt so rate limits on one domain don't block the rest.
// No API key required for any of these.

export function getLeaderboardEndpoints(eventId: string): string[] {
  return [
    // ESPN Site API (primary — same domain your Excel sheet uses)
    `https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${eventId}`,
    // ESPN Web API (alternate domain — mirrors same data, different rate limit bucket)
    `https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${eventId}`,
    // ESPN Core API (different path structure — used by ESPN app internals)
    `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/${eventId}/competitions/${eventId}/competitors?limit=200&lang=en&region=us`,
    // ESPN CDN scores endpoint (used by ESPN widget embeds — different infra)
    `https://cdn.espn.com/apis/site/v2/sports/golf/leaderboard?league=pga&event=${eventId}`,
    // ESPN fantasy/stats API (tertiary fallback)
    `https://site.api.espn.com/apis/fantasy/v2/games/flgolf/games?eventId=${eventId}&scoreSystemId=0`,
  ];
}

// ─── Rotating fetch with retry + exponential backoff ─────────────────────────

const RETRY_DELAYS_MS = [0, 1000, 2500, 5000]; // 4 attempts per endpoint

async function fetchWithRetry(url: string, attempt = 0): Promise<Response | null> {
  if (attempt > 0) {
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt] ?? 5000));
  }
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.espn.com/',
        Origin: 'https://www.espn.com',
      },
      cache: 'no-store', // always fresh — we do our own caching layer
    });
    if (res.ok) return res;
    console.warn(`[ESPN] ${url} → ${res.status}`);
    return null;
  } catch (e) {
    console.warn(`[ESPN] fetch error for ${url}:`, e);
    return null;
  }
}

/**
 * Try every endpoint in rotation until one succeeds.
 * Returns the raw JSON data and the name of the source that succeeded.
 * Returns null if every endpoint fails.
 */
export async function fetchLeaderboardRaw(eventId: string): Promise<{
  data: unknown;
  source: string;
} | null> {
  const endpoints = getLeaderboardEndpoints(eventId);

  // Rotate starting endpoint based on current minute so requests spread across sources
  const rotationOffset = Math.floor(Date.now() / 60_000) % endpoints.length;
  const rotated = [
    ...endpoints.slice(rotationOffset),
    ...endpoints.slice(0, rotationOffset),
  ];

  for (const url of rotated) {
    // Try up to 2 quick attempts per endpoint before moving on
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetchWithRetry(url, attempt);
      if (res) {
        try {
          const data = await res.json();
          // Validate the response has something useful
          if (isUsableLeaderboardData(data)) {
            console.log(`[ESPN] ✓ Got data from: ${new URL(url).hostname}`);
            return { data, source: new URL(url).hostname };
          }
        } catch {
          // JSON parse failed — try next
        }
      }
    }
  }

  console.error('[ESPN] All endpoints failed for eventId:', eventId);
  return null;
}

/** Quick sanity check — does the response look like leaderboard data? */
function isUsableLeaderboardData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  // Standard ESPN leaderboard shape
  if (Array.isArray(d.events) && (d.events as unknown[]).length > 0) return true;
  // Core API competitor list shape
  if (Array.isArray(d.items) && (d.items as unknown[]).length > 0) return true;
  return false;
}

// ─── Parse Leaderboard Response ──────────────────────────────────────────────

export function parseLeaderboard(data: ESPNLeaderboardResponse): {
  players: Record<string, Player>;
  fieldSize: number;
  cutLine: number;
} {
  // Handle core API competitor list shape (3rd endpoint)
  if ((data as unknown as ESPNFieldResponse)?.items && !(data as ESPNLeaderboardResponse)?.events) {
    return parseCoreApiCompetitors(data as unknown as ESPNFieldResponse);
  }

  const competition = data?.events?.[0]?.competitions?.[0];
  if (!competition) return { players: {}, fieldSize: 0, cutLine: 65 };

  const competitors = competition.competitors ?? [];
  const fieldSize = competitors.length;

  // Determine cut line from ESPN status text
  let cutLine = 65;
  const details = competition.status?.type?.detail ?? '';
  const cutMatch = details.match(/cut.*?(\d+)/i);
  if (cutMatch) cutLine = parseInt(cutMatch[1], 10);

  const players: Record<string, Player> = {};

  for (const comp of competitors) {
    const athlete = comp.athlete;
    if (!athlete) continue;

    const id = String(athlete.id ?? '');
    const name =
      athlete.displayName ?? `${athlete.firstName ?? ''} ${athlete.lastName ?? ''}`.trim();

    // Position — use ESPN's actual position field only (NOT sortOrder).
    // sortOrder is ESPN's tee-time/alphabetical sort and shows fake pre-tournament
    // standings. The real position only populates once players have teed off.
    const posStr = comp.status?.position?.displayName ?? comp.status?.position?.displayValue ?? '';
    let positionDisplay = posStr || '-';
    let position: number | null = null;

    if (posStr && posStr !== '' && posStr !== '-') {
      const numeric = parseInt(posStr.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(numeric)) position = numeric;
    }

    // Status
    const statusName = comp.status?.type?.name?.toLowerCase() ?? '';
    const statusDisplay = comp.status?.displayValue?.toLowerCase() ?? '';
    let status: Player['status'] = 'active';
    if (statusName.includes('cut') || statusDisplay === 'cut') status = 'cut';
    else if (statusName.includes('wd') || statusDisplay.includes('withdrew') || statusDisplay === 'wd') status = 'wd';
    else if (statusName.includes('dq') || statusDisplay === 'dq') status = 'dq';

    // Score vs par
    const scoreVal =
      comp.score?.displayValue ??
      comp.statistics?.find((s) => s.name === 'score' || s.abbreviation === 'SC')?.displayValue ??
      comp.statistics?.[0]?.displayValue ??
      'E';

    // Thru
    const thruRaw =
      comp.status?.thru?.toString() ??
      comp.status?.period?.toString() ??
      '-';
    const thruDisplay = thruRaw === '18' ? 'F' : (thruRaw === '0' || thruRaw === '' ? '-' : thruRaw);

    if (id) {
      players[id] = {
        id,
        name,
        position,
        positionDisplay,
        score: scoreVal,
        status,
        thru: thruDisplay,
      };
    }
  }

  return { players, fieldSize, cutLine };
}

/** Parse the ESPN Core API competitor list format */
function parseCoreApiCompetitors(data: ESPNFieldResponse): {
  players: Record<string, Player>;
  fieldSize: number;
  cutLine: number;
} {
  const items = data?.items ?? [];
  const players: Record<string, Player> = {};

  for (const item of items) {
    const id = String(item.athlete?.id ?? item.id ?? '');
    const name = item.athlete?.displayName ?? item.athlete?.fullName ?? 'Unknown';
    if (!id) continue;
    players[id] = {
      id,
      name,
      position: null,
      positionDisplay: '-',
      score: 'E',
      status: 'active',
      thru: '-',
    };
  }

  return { players, fieldSize: items.length, cutLine: 65 };
}

// ─── Parse pre-tournament field ───────────────────────────────────────────────

export function parseField(data: ESPNFieldResponse): { id: string; name: string }[] {
  const items = data?.items ?? [];
  return items.map((item) => ({
    id: String(item.athlete?.id ?? item.id ?? ''),
    name: item.athlete?.displayName ?? item.athlete?.fullName ?? 'Unknown',
  }));
}

// ─── TypeScript shapes (simplified) ──────────────────────────────────────────

export interface ESPNLeaderboardResponse {
  events?: {
    competitions?: {
      competitors?: ESPNCompetitor[];
      status?: {
        type?: { name?: string; detail?: string };
      };
    }[];
  }[];
}

interface ESPNCompetitor {
  athlete?: {
    id?: string | number;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    fullName?: string;
  };
  sortOrder?: number;
  score?: { displayValue?: string };
  statistics?: { name?: string; abbreviation?: string; displayValue?: string }[];
  status?: {
    displayValue?: string;
    thru?: number | string;
    period?: number;
    position?: { id?: string; displayName?: string; displayValue?: string; isTie?: boolean };
    type?: { name?: string; detail?: string };
  };
}

export interface ESPNFieldResponse {
  items?: {
    id?: string;
    athlete?: {
      id?: string | number;
      displayName?: string;
      fullName?: string;
    };
  }[];
}
