import { TOP_10_POINTS, SCORING_PLAYERS } from './constants';
import type { Player, PlayerScore, TeamScore, DraftPick } from './types';

/**
 * Calculate points for a single player based on their position.
 *
 * Rules:
 *  - Cut / WD / DQ  → cutLine + 1
 *  - Top 10 (1–10)  → fixed bonuses: -25,-15,-10,-8,-6,-5,-4,-3,-2,-1
 *  - 11+            → position number IS the point value (e.g. T15 = +15)
 */
export function calculatePoints(
  position: number | null,
  status: string,
  cutLine: number
): number {
  if (status === 'cut' || status === 'wd' || status === 'dq') {
    return cutLine + 1;
  }

  if (position === null || position === 0) {
    // Tournament hasn't started yet — treat as worst possible (not yet counted)
    return 9999;
  }

  if (position <= 10) {
    return TOP_10_POINTS[position - 1];
  }

  return position;
}

/**
 * Build a PlayerScore object for each of a user's draft picks
 * against the current leaderboard players map.
 */
/**
 * Build a name-based reverse lookup for when picks were stored with name keys
 * instead of ESPN numeric IDs (happens if ESPN wasn't loaded during draft).
 */
function buildNameLookup(playersMap: Record<string, Player>): Map<string, Player> {
  const map = new Map<string, Player>();
  for (const player of Object.values(playersMap)) {
    // Store by normalized name so we can fuzzy match
    const key = player.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\./g, '')
      .replace(/[-–]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    map.set(key, player);
  }
  return map;
}

export function buildPlayerScores(
  picks: DraftPick[],
  playersMap: Record<string, Player>,
  cutLine: number,
  prevRoundPositions: Record<string, number | null> | null = null
): PlayerScore[] {
  // Filter out admin-removed slots (sentinel value) before scoring
  const activePicks = picks.filter((p) => p.playerId !== '__removed__');

  // Build name lookup as fallback for picks stored without ESPN IDs
  const nameLookup = buildNameLookup(playersMap);

  const scores: PlayerScore[] = activePicks.map((pick) => {
    // Primary: look up by ESPN ID (numeric string like "4663")
    let player = playersMap[pick.playerId];

    // Fallback: match by normalized player name
    // This handles picks made before ESPN field was loaded (stored as name keys)
    if (!player && pick.playerName) {
      const nameKey = pick.playerName
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\./g, '')
        .replace(/[-–]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      player = nameLookup.get(nameKey);

      // Also try the pick.playerId as a name key
      if (!player) {
        player = nameLookup.get(pick.playerId);
      }

      // Last resort: last-name match — ONLY if exactly one player has that last name
      // (skipped if ambiguous, e.g. Hojgaard brothers, multiple Johnsons)
      if (!player) {
        const lastName = nameKey.split(' ').pop() ?? '';
        if (lastName.length > 3) {
          const lastNameMatches: Player[] = [];
          for (const [key, p] of nameLookup) {
            if (key.endsWith(' ' + lastName) || key === lastName) {
              lastNameMatches.push(p);
            }
          }
          if (lastNameMatches.length === 1) {
            player = lastNameMatches[0]; // unambiguous — safe to use
          }
          // if 2+ matches, leave player undefined rather than guess wrong
        }
      }
    }

    if (!player) {
      return {
        playerId: pick.playerId,
        playerName: pick.playerName,
        position: 9999,
        positionDisplay: '-',
        points: 9999,
        status: 'active' as const,
        countsInTop3: false,
        thru: '-',
        positionChange: null,
        currentRound: 1,
      };
    }

    const points = calculatePoints(player.position, player.status, cutLine);

    // Position change vs end of previous round
    let positionChange: number | null = null;
    if (prevRoundPositions !== null && player.position !== null) {
      const prevPos = prevRoundPositions[player.id] ?? prevRoundPositions[pick.playerId] ?? null;
      if (prevPos !== null) {
        // positive = improved (lower number = better position)
        positionChange = prevPos - player.position;
      }
    }

    return {
      playerId: player.id,
      playerName: player.name,
      position: player.position ?? 9999,
      positionDisplay: player.positionDisplay,
      points,
      status: player.status,
      countsInTop3: false, // set below
      thru: player.thru,
      positionChange,
      currentRound: player.currentRound ?? 1,
    };
  });

  // Sort ascending (lower = better) and mark top SCORING_PLAYERS
  const sorted = [...scores].sort((a, b) => a.points - b.points);
  const top3Ids = new Set(sorted.slice(0, SCORING_PLAYERS).map((s) => s.playerId));

  return scores.map((s) => ({
    ...s,
    countsInTop3: top3Ids.has(s.playerId),
  }));
}

/**
 * Calculate full team scores and rankings for all users in a tournament.
 */
export function calculateLeaderboard(
  userPicksMap: Record<string, { username: string; picks: DraftPick[] }>,
  playersMap: Record<string, Player>,
  cutLine: number,
  prevRoundPositions: Record<string, number | null> | null = null
): TeamScore[] {
  const teams: TeamScore[] = Object.entries(userPicksMap).map(
    ([userId, { username, picks }]) => {
      const playerScores = buildPlayerScores(picks, playersMap, cutLine, prevRoundPositions);

      const sorted = [...playerScores].sort((a, b) => a.points - b.points);
      const top3 = sorted.slice(0, SCORING_PLAYERS);
      const top3Score = top3.reduce((sum, p) => sum + p.points, 0);

      return {
        userId,
        username,
        players: playerScores,
        top3Score,
        rank: 0, // set below
      };
    }
  );

  /**
   * Sort teams by:
   * 1. top3Score ascending (lower = better)
   * 2. Tiebreaker: compare each team's full roster sorted by position,
   *    best player first, continuing down the roster until a difference is found.
   */
  function getRosterPositionsSorted(team: TeamScore): number[] {
    return team.players
      .map((p) => (p.position === null || p.position === 9999 ? 999 : p.position))
      .sort((a, b) => a - b);
  }

  teams.sort((a, b) => {
    if (a.top3Score !== b.top3Score) return a.top3Score - b.top3Score;

    // Tiebreaker: step through each roster slot (best → worst) until difference found
    const aPosArr = getRosterPositionsSorted(a);
    const bPosArr = getRosterPositionsSorted(b);
    const slots = Math.max(aPosArr.length, bPosArr.length);

    for (let i = 0; i < slots; i++) {
      const aPos = aPosArr[i] ?? 999;
      const bPos = bPosArr[i] ?? 999;
      if (aPos !== bPos) return aPos - bPos; // lower position = better rank
    }

    return 0; // truly identical — same rank
  });

  // Assign ranks — teams with identical score AND identical tiebreaker positions share a rank
  teams.forEach((team, i) => {
    if (i === 0) {
      team.rank = 1;
      return;
    }
    const prev = teams[i - 1];
    const sameScore = team.top3Score === prev.top3Score;
    const sameTiebreaker =
      sameScore &&
      JSON.stringify(getRosterPositionsSorted(team)) ===
        JSON.stringify(getRosterPositionsSorted(prev));

    team.rank = sameTiebreaker ? prev.rank : i + 1;
  });

  return teams;
}

/**
 * Build the full snake draft order for N rounds with 8 users.
 * Round 1: users in order 0..7
 * Round 2: users in reverse 7..0
 * etc.
 */
export function buildSnakeDraftOrder(
  userIds: string[],
  totalPicks: number // maxPicks * 8
): string[] {
  const order: string[] = [];
  let round = 0;

  while (order.length < totalPicks) {
    const roundUsers =
      round % 2 === 0 ? [...userIds] : [...userIds].reverse();

    for (const uid of roundUsers) {
      if (order.length >= totalPicks) break;
      order.push(uid);
    }
    round++;
  }

  return order;
}

/**
 * Given the current pick index and snake order, return who picks next.
 */
export function getCurrentPicker(
  snakeDraftOrder: string[],
  currentPickIndex: number
): string | null {
  return snakeDraftOrder[currentPickIndex] ?? null;
}
