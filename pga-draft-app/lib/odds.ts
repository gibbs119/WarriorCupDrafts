// ─── Odds Sources ─────────────────────────────────────────────────────────────
// Priority order:
//  1. The Odds API  (free tier — 500 req/mo, needs NEXT_PUBLIC_ODDS_API_KEY)
//  2. DraftKings    (public CDN endpoint, no key)
//  3. ESPN BET      (public endpoint, no key)

export interface OddsPlayer {
  id: string;               // normalized name used as stable key
  name: string;             // display name from odds source
  espnName: string | null;  // matched ESPN name (null until matched)
  americanOdds: number;     // e.g. +1200 or -110
  impliedProb: number;      // 0–100 percentage
  oddsDisplay: string;      // e.g. "+1200" or "-110"
  bookmaker: string;        // source label
}

// ─── The Odds API endpoints (free, ~500 req/mo, needs API key) ────────────────

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

export function getOddsApiUrl(apiKey: string): string {
  return `${ODDS_API_BASE}/sports/golf_pga/odds/?apiKey=${apiKey}&regions=us&markets=outrights&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`;
}

// ─── DraftKings public CDN (no key) ──────────────────────────────────────────
// The subcategory ID 4519 = "Tournament Winner" for PGA events.
// We fetch the full golf category and filter to the current tournament.

export const DRAFTKINGS_GOLF_URL =
  'https://sportsbook-nash.draftkings.com/api/odds/v1/leagues/2/categories/583/subcategories/4519';

// Fallback: DK alternate endpoint
export const DRAFTKINGS_ALT_URL =
  'https://sportsbook.draftkings.com/api/odds/v1/leagues/2/categories/583';

// ─── Name Normalization ───────────────────────────────────────────────────────
// Odds sources often differ from ESPN in:
//   - Accent characters:  "Sébastien Hebert" → "Sebastien Hebert"
//   - Suffixes:           "Tom Kim" (ESPN) vs "Kim Tom" (some books use last, first)
//   - Nicknames:          "Cam Davis" vs "Cameron Davis"
//   - Hyphens:            "Si Woo Kim" vs "Si-Woo Kim"
//   - Dots:               "C.T. Pan" vs "CT Pan"

const NICKNAME_MAP: Record<string, string> = {
  'cam davis': 'cameron davis',
  'cam smith': 'cameron smith',
  'cam young': 'cameron young',
  'max homa': 'max homa',
  'ricky fowler': 'rickie fowler',
  'tj kim': 'tom kim',
  'si woo kim': 'si woo kim',
  'si-woo kim': 'si woo kim',
  'byeong hun an': 'byeong hun an',
  'byeong-hun an': 'byeong hun an',
  'k.h. lee': 'kyoung-hoon lee',
  'kh lee': 'kyoung-hoon lee',
  'kyounghoon lee': 'kyoung-hoon lee',
  'sungjae im': 'sungjae im',
  's.h. kim': 'sung-hyun kim',
  'ludvig aberg': 'ludvig aberg',
  'ct pan': 'c.t. pan',
};

/**
 * Strip accents, punctuation, normalize whitespace and casing.
 * Returns a canonical key for fuzzy matching.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accent marks
    .replace(/\./g, '')                // remove dots: C.T. → CT
    .replace(/[-–]/g, ' ')            // hyphens to spaces
    .replace(/\s+/g, ' ')             // collapse whitespace
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '') // strip suffixes
    .trim();
}

/**
 * Apply known nickname overrides after normalization.
 */
function applyNicknameMap(normalized: string): string {
  return NICKNAME_MAP[normalized] ?? normalized;
}

/**
 * Canonical key used for matching between odds and ESPN.
 */
export function playerKey(name: string): string {
  return applyNicknameMap(normalizeName(name));
}

/**
 * Build a lookup map from canonical key → ESPN display name.
 * Pass in ESPN player names to pre-build the reverse lookup.
 */
export function buildEspnLookup(
  espnNames: string[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of espnNames) {
    map.set(playerKey(name), name);
  }
  return map;
}

/**
 * Attempt to find the ESPN display name for an odds-source name.
 * Returns null if no match found.
 */
export function matchToEspnName(
  oddsName: string,
  espnLookup: Map<string, string>
): string | null {
  const key = playerKey(oddsName);
  if (espnLookup.has(key)) return espnLookup.get(key)!;

  // Last-name-only fallback: find ESPN name whose last word matches
  const lastName = key.split(' ').pop() ?? '';
  if (lastName.length > 3) {
    for (const [espnKey, espnName] of espnLookup) {
      if (espnKey.endsWith(' ' + lastName) || espnKey === lastName) {
        return espnName;
      }
    }
  }

  return null;
}

// ─── Parse The Odds API response ─────────────────────────────────────────────

interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  bookmakers?: {
    key: string;
    title: string;
    markets?: {
      key: string;
      outcomes?: { name: string; price: number }[];
    }[];
  }[];
}

export function parseOddsApiResponse(events: OddsApiEvent[]): OddsPlayer[] {
  // Find the soonest upcoming golf event
  const now = Date.now();
  const upcoming = events
    .filter((e) => new Date(e.commence_time).getTime() > now - 86400000) // within past day
    .sort((a, b) => new Date(a.commence_time).getTime() - new Date(b.commence_time).getTime());

  if (upcoming.length === 0) return [];

  const event = upcoming[0];
  const players: Map<string, OddsPlayer> = new Map();

  for (const bookmaker of event.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      if (market.key !== 'outrights') continue;
      for (const outcome of market.outcomes ?? []) {
        const key = playerKey(outcome.name);
        if (!players.has(key) || Math.abs(outcome.price) < Math.abs(players.get(key)!.americanOdds)) {
          // Use the best (shortest) odds across bookmakers
          players.set(key, {
            id: key,
            name: outcome.name,
            espnName: null,
            americanOdds: outcome.price,
            impliedProb: americanToImplied(outcome.price),
            oddsDisplay: formatAmericanOdds(outcome.price),
            bookmaker: bookmaker.title,
          });
        }
      }
    }
  }

  return sortByOdds([...players.values()]);
}

// ─── Parse DraftKings public API response ─────────────────────────────────────

interface DKCategory {
  eventGroupName?: string;
  offerCategories?: {
    offerCategoryId?: number;
    name?: string;
    offerSubcategoryDescriptors?: {
      subcategoryId?: number;
      name?: string;
      offerSubcategory?: {
        offers?: {
          label?: string;
          outcomes?: {
            label?: string;
            oddsAmerican?: string;
            oddsDecimal?: number;
            participant?: string;
          }[];
        }[];
      };
    }[];
  }[];
}

export function parseDraftKingsResponse(data: DKCategory | { eventGroup?: DKCategory }): OddsPlayer[] {
  const group = (data as { eventGroup?: DKCategory }).eventGroup ?? (data as DKCategory);
  const players: OddsPlayer[] = [];

  for (const cat of group.offerCategories ?? []) {
    for (const sub of cat.offerSubcategoryDescriptors ?? []) {
      if (!sub.name?.toLowerCase().includes('winner') &&
          !sub.name?.toLowerCase().includes('outright')) continue;

      for (const offer of sub.offerSubcategory?.offers ?? []) {
        for (const outcome of offer.outcomes ?? []) {
          const name = outcome.participant ?? outcome.label ?? '';
          if (!name) continue;

          const american = parseInt(outcome.oddsAmerican ?? '9999', 10);
          if (isNaN(american)) continue;

          const key = playerKey(name);
          players.push({
            id: key,
            name,
            espnName: null,
            americanOdds: american,
            impliedProb: americanToImplied(american),
            oddsDisplay: formatAmericanOdds(american),
            bookmaker: 'DraftKings',
          });
        }
      }
    }
  }

  // Deduplicate by key (keep best odds)
  const deduped = new Map<string, OddsPlayer>();
  for (const p of players) {
    const existing = deduped.get(p.id);
    if (!existing || p.impliedProb > existing.impliedProb) {
      deduped.set(p.id, p);
    }
  }

  return sortByOdds([...deduped.values()]);
}

// ─── Odds math helpers ────────────────────────────────────────────────────────

export function americanToImplied(american: number): number {
  if (american > 0) return (100 / (american + 100)) * 100;
  return (Math.abs(american) / (Math.abs(american) + 100)) * 100;
}

export function formatAmericanOdds(american: number): string {
  return american > 0 ? `+${american}` : `${american}`;
}

function sortByOdds(players: OddsPlayer[]): OddsPlayer[] {
  // Lower implied prob = higher odds = longer shot → sort favorites first (highest implied prob)
  return players.sort((a, b) => b.impliedProb - a.impliedProb);
}
