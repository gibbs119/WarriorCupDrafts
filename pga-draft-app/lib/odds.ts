// ─── Odds Sources ─────────────────────────────────────────────────────────────
// Priority order:
//  1. The Odds API  (free tier — 500 req/mo, needs NEXT_PUBLIC_ODDS_API_KEY)
//  2. DraftKings    (multiple public CDN endpoint patterns)
//  3. ESPN field    (guaranteed — used as last resort for player names only)

export interface OddsPlayer {
  id: string;               // normalized name key
  name: string;             // display name from odds source
  espnName: string | null;  // matched ESPN name (null until matched)
  americanOdds: number;     // e.g. +1200 or -110
  impliedProb: number;      // 0–100 percentage
  oddsDisplay: string;      // e.g. "+1200" or "-110"
  bookmaker: string;        // source label
  // Top 10 finish odds (null if market not available)
  top10AmericanOdds: number | null;
  top10Display: string | null;
  top10ImpliedProb: number | null;
}

// ─── The Odds API ─────────────────────────────────────────────────────────────
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

export function getOddsApiUrl(apiKey: string): string {
  return `${ODDS_API_BASE}/sports/golf_pga/odds/?apiKey=${apiKey}&regions=us&markets=outrights&oddsFormat=american&bookmakers=draftkings,fanduel,betmgm`;
}

// ─── DraftKings public API endpoints ─────────────────────────────────────────
// Multiple patterns tried in order — DK changes these periodically.
// All are public, no API key required.
// League 2 = PGA Tour golf in DraftKings internal system.

export const DRAFTKINGS_URLS = [
  // Primary: tournament winner outright market
  'https://sportsbook-nash.draftkings.com/api/odds/v1/leagues/2/categories/583/subcategories/4519',
  // Alternate subcategory IDs DK has used
  'https://sportsbook-nash.draftkings.com/api/odds/v1/leagues/2/categories/583/subcategories/4520',
  // Full category (includes all markets, we filter to winner)
  'https://sportsbook-nash.draftkings.com/api/odds/v1/leagues/2/categories/583',
  // Alt domain
  'https://sportsbook.draftkings.com/api/odds/v1/leagues/2/categories/583/subcategories/4519',
];

// Keep legacy exports so existing route.ts doesn't break
export const DRAFTKINGS_GOLF_URL = DRAFTKINGS_URLS[0];
export const DRAFTKINGS_ALT_URL = DRAFTKINGS_URLS[2];

// ─── Tournament slug → DraftKings URL mapping ─────────────────────────────────
// Used to help identify the right event when DK returns multiple tournaments.
export const TOURNAMENT_SLUGS: Record<string, string[]> = {
  'players-championship': ['players championship', 'the players', 'players'],
  'masters': ['masters', 'the masters', 'augusta'],
  'pga-championship': ['pga championship', 'pga champ'],
  'us-open': ['u.s. open', 'us open', 'united states open'],
  'the-open': ['the open', 'open championship', 'british open'],
};

// ─── Name Normalization ───────────────────────────────────────────────────────
// Handles all common differences between DraftKings and ESPN name formats:
//   - Accents:   "Séb Hebert"  → "seb hebert"
//   - Hyphens:   "Si-Woo Kim"  → "si woo kim"
//   - Dots:      "C.T. Pan"    → "ct pan"
//   - Nicknames: "Cam Davis"   → "cameron davis"
//   - Suffixes:  "Tom Kim Jr"  → "tom kim"

const NICKNAME_MAP: Record<string, string> = {
  // Cameras
  'cam davis': 'cameron davis',
  'cam smith': 'cameron smith',
  'cam young': 'cameron young',
  // Common nicknames / ESPN vs DK variations
  'ricky fowler': 'rickie fowler',
  'tj kim': 'tom kim',
  // Korean name variations
  'si woo kim': 'si woo kim',
  'si-woo kim': 'si woo kim',
  'byeong hun an': 'byeong hun an',
  'byeong-hun an': 'byeong hun an',
  'sungjae im': 'sungjae im',
  // Korean initials → full name
  'k.h. lee': 'kyoung-hoon lee',
  'kh lee': 'kyoung-hoon lee',
  'kyounghoon lee': 'kyoung-hoon lee',
  'kyoung hoon lee': 'kyoung-hoon lee',
  's.h. kim': 'sung-hyun kim',
  // European name normalization
  'ludvig aberg': 'ludvig aberg',
  'ct pan': 'c.t. pan',
  // DK sometimes uses "Last, First" format for non-English names
};

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    // Explicit substitutions for characters that don't decompose via NFD
    // (ø, æ, å, ð, þ, ß are atomic Unicode chars — stripping combining marks won't help)
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
    .replace(/ð/g, 'd').replace(/þ/g, 'th').replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip accents (é→e, ü→u, etc.)
    .replace(/\./g, '')                 // remove dots: C.T. → CT
    .replace(/[-–]/g, ' ')             // hyphens to spaces
    .replace(/\s+/g, ' ')              // collapse whitespace
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '') // strip suffixes
    .trim();
}

function applyNicknameMap(normalized: string): string {
  return NICKNAME_MAP[normalized] ?? normalized;
}

export function playerKey(name: string): string {
  return applyNicknameMap(normalizeName(name));
}

export function buildEspnLookup(espnNames: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of espnNames) {
    map.set(playerKey(name), name);
  }
  return map;
}

export function matchToEspnName(
  oddsName: string,
  espnLookup: Map<string, string>
): string | null {
  const key = playerKey(oddsName);
  if (espnLookup.has(key)) return espnLookup.get(key)!;

  // Last-name fallback — only if exactly one ESPN player has that last name
  // Skipped if ambiguous (e.g. Nicolai vs Rasmus Hojgaard, multiple Johnsons)
  const lastName = key.split(' ').pop() ?? '';
  if (lastName.length > 3) {
    const matches: string[] = [];
    for (const [espnKey, espnName] of espnLookup) {
      if (espnKey.endsWith(' ' + lastName) || espnKey === lastName) {
        matches.push(espnName);
      }
    }
    if (matches.length === 1) return matches[0]; // unambiguous
  }

  return null;
}

// ─── Parse The Odds API response ──────────────────────────────────────────────
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
  const now = Date.now();
  const upcoming = events
    .filter((e) => new Date(e.commence_time).getTime() > now - 86400000)
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
          players.set(key, {
            id: key,
            name: outcome.name,
            espnName: null,
            americanOdds: outcome.price,
            impliedProb: americanToImplied(outcome.price),
            oddsDisplay: formatAmericanOdds(outcome.price),
            bookmaker: bookmaker.title,
            top10AmericanOdds: null,
            top10Display: null,
            top10ImpliedProb: null,
          });
        }
      }
    }
  }

  return sortByOdds(Array.from(players.values()));
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

export function parseDraftKingsResponse(
  data: DKCategory | { eventGroup?: DKCategory },
  tournamentId?: string
): OddsPlayer[] {
  const group = (data as { eventGroup?: DKCategory }).eventGroup ?? (data as DKCategory);
  const players: OddsPlayer[] = [];

  // If we have multiple event groups, try to find the right tournament
  const eventName = group.eventGroupName?.toLowerCase() ?? '';
  const slugs = tournamentId ? (TOURNAMENT_SLUGS[tournamentId] ?? []) : [];
  const isRightEvent = slugs.length === 0 || slugs.some((s) => eventName.includes(s));

  if (!isRightEvent && slugs.length > 0) {
    // This DK response is for a different tournament - skip
    return [];
  }

  // top10Map: player key → best top-10 odds found in the response
  const top10Map = new Map<string, { americanOdds: number; display: string; impliedProb: number }>();

  for (const cat of group.offerCategories ?? []) {
    for (const sub of cat.offerSubcategoryDescriptors ?? []) {
      const subName = sub.name?.toLowerCase() ?? '';
      const isWinner = subName.includes('winner') || subName.includes('outright') || subName.includes('to win');
      const isTop10 = subName.includes('top 10') || subName.includes('top10') || subName.includes('top-10');

      if (!isWinner && !isTop10) continue;

      for (const offer of sub.offerSubcategory?.offers ?? []) {
        for (const outcome of offer.outcomes ?? []) {
          const name = outcome.participant ?? outcome.label ?? '';
          if (!name || name.toLowerCase().includes('field')) continue;

          const american = parseInt(outcome.oddsAmerican ?? '9999', 10);
          if (isNaN(american) || american === 9999) continue;

          const key = playerKey(name);

          if (isWinner) {
            players.push({
              id: key,
              name,
              espnName: null,
              americanOdds: american,
              impliedProb: americanToImplied(american),
              oddsDisplay: formatAmericanOdds(american),
              bookmaker: 'DraftKings',
              top10AmericanOdds: null,
              top10Display: null,
              top10ImpliedProb: null,
            });
          }

          if (isTop10) {
            const existing = top10Map.get(key);
            const prob = americanToImplied(american);
            if (!existing || prob > existing.impliedProb) {
              top10Map.set(key, { americanOdds: american, display: formatAmericanOdds(american), impliedProb: prob });
            }
          }
        }
      }
    }
  }

  // Deduplicate win odds — keep best odds per player
  const deduped = new Map<string, OddsPlayer>();
  for (const p of players) {
    const existing = deduped.get(p.id);
    if (!existing || p.impliedProb > existing.impliedProb) {
      deduped.set(p.id, p);
    }
  }

  // Attach top-10 odds to each player
  for (const [key, player] of deduped) {
    const t10 = top10Map.get(key);
    if (t10) {
      player.top10AmericanOdds = t10.americanOdds;
      player.top10Display = t10.display;
      player.top10ImpliedProb = t10.impliedProb;
    }
  }

  return sortByOdds(Array.from(deduped.values()));
}

// ─── Odds math ────────────────────────────────────────────────────────────────
export function americanToImplied(american: number): number {
  if (american > 0) return (100 / (american + 100)) * 100;
  return (Math.abs(american) / (Math.abs(american) + 100)) * 100;
}

export function formatAmericanOdds(american: number): string {
  return american > 0 ? `+${american}` : `${american}`;
}

function sortByOdds(players: OddsPlayer[]): OddsPlayer[] {
  return players.sort((a, b) => b.impliedProb - a.impliedProb);
}
