// ─── Official World Golf Ranking (OWGR) ──────────────────────────────────────
// Primary source: OpenAI API (uses training data + optional web search).
// Fallback: owgr.com public API (often blocked in server environments).
// Rankings update weekly; results are cached at the odds-route level.

import { playerKey } from './odds';

export interface OwgrEntry {
  rank: number;
  name: string;
  key: string;
}

// ─── OpenAI source (primary) ──────────────────────────────────────────────────
// Asks gpt-4o-mini for OWGR for a specific list of player names.
// Temperature 0 — we want factual, not creative.
async function fetchOwgrFromOpenAI(playerNames: string[]): Promise<OwgrEntry[] | null> {
  const apiKey = process.env.OPENAI_API_KEY ?? '';
  if (!apiKey || playerNames.length === 0) return null;

  // Batch to ≤80 names to stay within token budget
  const batch = playerNames.slice(0, 80).join(', ');
  const prompt =
    `Return the current Official World Golf Rankings (OWGR) for these players as JSON. ` +
    `Format: {"rankings": [{"name": "Full Name", "rank": 1}]}. ` +
    `Only include players whose rank you are confident about. ` +
    `Players: ${batch}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 2000,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.warn(`[OWGR] OpenAI returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';
    return parseOwgrJson(text);
  } catch (e) {
    console.warn('[OWGR] OpenAI fetch error:', e);
    return null;
  }
}

function parseOwgrJson(text: string): OwgrEntry[] {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const list: { name?: string; rank?: number }[] =
      parsed.rankings ?? parsed.players ?? parsed;
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item.name && typeof item.rank === 'number' && item.rank > 0)
      .map((item) => ({
        rank: item.rank as number,
        name: item.name as string,
        key: playerKey(item.name as string),
      }));
  } catch {
    return [];
  }
}

// ─── owgr.com fallback ────────────────────────────────────────────────────────
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseOwgrResponse(data: any): OwgrEntry[] {
  const list =
    data?.playerRankings ??
    data?.rankings ??
    data?.players ??
    (Array.isArray(data) ? data : null);
  if (!Array.isArray(list)) return [];

  const entries: OwgrEntry[] = [];
  for (const item of list) {
    const rank =
      item.currentRank ?? item.rank ?? item.rankingPosition ?? item.position;
    const name =
      item.name ??
      item.playerName ??
      (item.firstName && item.lastName ? `${item.firstName} ${item.lastName}` : null);
    if (!rank || !name || typeof rank !== 'number') continue;
    entries.push({ rank, name, key: playerKey(name) });
  }
  return entries;
}

async function fetchFromOwgrCom(): Promise<OwgrEntry[] | null> {
  try {
    const res = await fetch(OWGR_URL, { headers: BROWSER_HEADERS, cache: 'no-store' });
    if (!res.ok) {
      console.warn(`[OWGR] owgr.com returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const entries = parseOwgrResponse(data);
    if (entries.length < 10) return null;
    console.log(`[OWGR] owgr.com: fetched ${entries.length} rankings`);
    return entries;
  } catch (e) {
    console.warn('[OWGR] owgr.com fetch error:', e);
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
// playerNames: pass the list of players in the draft pool so OpenAI can focus
// its response. owgr.com is tried first (free, no key); OpenAI is the fallback.
export async function fetchOwgrRankings(playerNames?: string[]): Promise<OwgrEntry[] | null> {
  // 1. Try owgr.com (free, full list)
  const owgrResult = await fetchFromOwgrCom();
  if (owgrResult && owgrResult.length >= 10) return owgrResult;

  // 2. Fall back to OpenAI (uses OPENAI_API_KEY)
  if (playerNames && playerNames.length > 0) {
    const openaiResult = await fetchOwgrFromOpenAI(playerNames);
    if (openaiResult && openaiResult.length > 0) {
      console.log(`[OWGR] OpenAI: got ${openaiResult.length} rankings`);
      return openaiResult;
    }
  }

  return null;
}

// ─── Build lookup map: playerKey → rank ──────────────────────────────────────
export function buildOwgrLookup(entries: OwgrEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    map.set(e.key, e.rank);
  }
  return map;
}
