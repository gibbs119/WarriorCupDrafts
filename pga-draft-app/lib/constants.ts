// ─── Pre-loaded Users ────────────────────────────────────────────────────────
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
// Draft night = Sunday before Thursday tee-off
// espnEventId is pre-filled where known. Admin can override in settings.

export const TOURNAMENTS = [
  {
    id: 'players-championship',
    name: 'The Players Championship',
    shortName: 'THE PLAYERS',
    year: 2026,
    startDate: 'March 12–15, 2026',
    draftDate: 'March 8, 2026',       // tonight!
    espnEventId: '401811937',          // confirmed 2026 ESPN ID
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
    year: 2026,
    startDate: 'April 9–12, 2026',
    draftDate: 'April 5, 2026',
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
    year: 2026,
    startDate: 'May 14–17, 2026',
    draftDate: 'May 10, 2026',
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
    year: 2026,
    startDate: 'June 18–21, 2026',
    draftDate: 'June 14, 2026',
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
    year: 2026,
    startDate: 'July 16–19, 2026',
    draftDate: 'July 12, 2026',
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
export const TOP_10_POINTS = [-25, -15, -10, -8, -6, -5, -4, -3, -2, -1];
export const SCORING_PLAYERS = 3;
export const PICK_TIMER_SECONDS = 120;
