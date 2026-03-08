// ─── Pre-loaded Users ────────────────────────────────────────────────────────
// Emails follow pattern: username@pgadraft.com (set real emails after setup)

export const USERS = [
  { username: 'Gibbs',  email: 'gibbs@pgadraft.com',  role: 'admin' as const },
  { username: 'Ryan',   email: 'ryan@pgadraft.com',   role: 'user'  as const },
  { username: 'Doby',   email: 'doby@pgadraft.com',   role: 'user'  as const },
  { username: 'Kev',    email: 'kev@pgadraft.com',    role: 'user'  as const },
  { username: 'Dief',   email: 'dief@pgadraft.com',   role: 'user'  as const },
  { username: 'Stevie', email: 'stevie@pgadraft.com', role: 'user'  as const },
  { username: 'Geoff',  email: 'geoff@pgadraft.com',  role: 'user'  as const },
  { username: 'Erm',    email: 'erm@pgadraft.com',    role: 'user'  as const },
];

// ─── Tournaments ─────────────────────────────────────────────────────────────
// espnEventId is left blank — Gibbs sets it in the Admin panel before each draft.

export const TOURNAMENTS = [
  {
    id: 'players-championship',
    name: 'The Players Championship',
    shortName: 'THE PLAYERS',
    year: 2025,
    startDate: 'March 13–16, 2025',
    espnEventId: '',   // Admin sets this
    fieldSize: 0,
    maxPicks: 5,
    status: 'upcoming' as const,
    draftOrder: [],
    draftComplete: false,
    cutLine: 65,
  },
  {
    id: 'masters',
    name: 'The Masters',
    shortName: 'MASTERS',
    year: 2025,
    startDate: 'April 10–13, 2025',
    espnEventId: '',
    fieldSize: 0,
    maxPicks: 4,
    status: 'upcoming' as const,
    draftOrder: [],
    draftComplete: false,
    cutLine: 50,
  },
  {
    id: 'pga-championship',
    name: 'PGA Championship',
    shortName: 'PGA CHAMP.',
    year: 2025,
    startDate: 'May 15–18, 2025',
    espnEventId: '',
    fieldSize: 0,
    maxPicks: 5,
    status: 'upcoming' as const,
    draftOrder: [],
    draftComplete: false,
    cutLine: 70,
  },
  {
    id: 'us-open',
    name: 'U.S. Open',
    shortName: 'U.S. OPEN',
    year: 2025,
    startDate: 'June 12–15, 2025',
    espnEventId: '',
    fieldSize: 0,
    maxPicks: 5,
    status: 'upcoming' as const,
    draftOrder: [],
    draftComplete: false,
    cutLine: 60,
  },
  {
    id: 'the-open',
    name: 'The Open Championship',
    shortName: 'THE OPEN',
    year: 2025,
    startDate: 'July 17–20, 2025',
    espnEventId: '',
    fieldSize: 0,
    maxPicks: 5,
    status: 'upcoming' as const,
    draftOrder: [],
    draftComplete: false,
    cutLine: 65,
  },
];

// ─── Scoring ─────────────────────────────────────────────────────────────────

// Top 10 bonuses (index 0 = 1st place, index 9 = 10th place)
export const TOP_10_POINTS = [-25, -15, -10, -8, -6, -5, -4, -3, -2, -1];

// Number of players whose scores count toward team total
export const SCORING_PLAYERS = 3;

// Default pick timer in seconds (0 = no timer)
export const PICK_TIMER_SECONDS = 120;
