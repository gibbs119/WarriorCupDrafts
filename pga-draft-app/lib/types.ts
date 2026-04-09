// ─── User & Auth ────────────────────────────────────────────────────────────

export interface AppUser {
  uid: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
}

// ─── Tournaments ─────────────────────────────────────────────────────────────

export type TournamentStatus = 'upcoming' | 'drafting' | 'active' | 'completed';

export interface Tournament {
  id: string;
  name: string;
  shortName: string;
  espnEventId: string;       // Set by admin before draft
  fieldSize: number;         // Populated from ESPN
  maxPicks: number;          // 4 if fieldSize < 100, else 5
  status: TournamentStatus;
  draftOrder: string[];      // Array of UIDs in snake order
  draftComplete: boolean;
  startDate: string;         // Display string e.g. "March 13-16, 2025"
  cutLine: number;           // Position number of cut line (e.g. 65)
  year: number;
}

// ─── Draft ───────────────────────────────────────────────────────────────────

export interface DraftPick {
  userId: string;
  username: string;
  playerId: string;
  playerName: string;
  pickNumber: number;        // 1-indexed overall pick number
  round: number;             // 1-indexed round
  timestamp: number;
}

export interface DraftState {
  tournamentId: string;
  picks: DraftPick[];
  currentPickIndex: number;  // 0-indexed; index into snakeDraftOrder
  snakeDraftOrder: string[]; // Full snake order expanded (all UIDs in pick order)
  status: 'waiting' | 'open' | 'complete';
}

// ─── Players & Scoring ───────────────────────────────────────────────────────

export type PlayerStatus = 'active' | 'cut' | 'wd' | 'dq';

export interface Player {
  id: string;
  name: string;
  position: number | null;  // null = not yet started / unknown
  positionDisplay: string;  // e.g. "T3", "CUT", "WD", "1"
  score: string;            // e.g. "-12", "E", "+3"
  status: PlayerStatus;
  thru: string;             // e.g. "F", "14", "-"
  currentRound?: number;         // ESPN round number (1-4)
  worldRanking?: number | null;  // Official World Golf Ranking (from ESPN stats)
  teeTime?: string | null;       // ISO string from ESPN, null when unavailable
  roundScores?: (string | null)[]; // [R1, R2, R3, R4] score-to-par per round e.g. "-3", "E", "+2"
}

export interface PlayerScore {
  playerId: string;
  playerName: string;
  position: number;          // numeric, used for point calc
  positionDisplay: string;
  points: number;            // computed point value
  status: PlayerStatus;
  countsInTop3: boolean;
  thru: string;
  positionChange: number | null;  // positive = moved up (better), negative = moved down, null = no data
  currentRound: number;           // which round ESPN says they're in
  score: string;                  // golf score-to-par display e.g. "-3", "E", "+2"
}

export interface TeamScore {
  userId: string;
  username: string;
  players: PlayerScore[];
  top3Score: number;         // sum of best 3 players' points
  rank: number;
  disqualified?: boolean;    // Reed Rule: team forfeits all points
}

// ─── WD Replacements ─────────────────────────────────────────────────────────

export interface WDReplacement {
  userId: string;
  username: string;
  droppedPlayerId: string;
  droppedPlayerName: string;
  replacementPlayerId: string;
  replacementPlayerName: string;
  requestedAt: number;       // timestamp
  approvedAt?: number;
  approvedBy?: string;       // admin uid
  status: 'pending' | 'approved' | 'denied';
  note?: string;             // admin note
}

// ─── Admin Roster Edit ────────────────────────────────────────────────────────

export interface RosterEdit {
  editedBy: string;          // admin uid
  editedByName: string;
  editedAt: number;
  userId: string;
  username: string;
  oldPickId: string;
  oldPickName: string;
  newPickId: string;
  newPickName: string;
  reason?: string;
}

// ─── History ─────────────────────────────────────────────────────────────────

export interface TournamentResult {
  tournamentId: string;
  tournamentName: string;
  year: number;
  rank: number;
  top3Score: number;
  players: PlayerScore[];
}

export interface UserHistory {
  uid: string;
  username: string;
  results: TournamentResult[];
  totalPoints: number;       // sum of all top3Scores across tournaments
  wins: number;              // number of tournament wins (rank 1)
  avgRank: number;
}
