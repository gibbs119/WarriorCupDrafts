// ─── Tournament Visual Themes ─────────────────────────────────────────────────
// Each theme matches the official branding of the real tournament.
// Used by draft room and leaderboard pages for immersive, per-event theming.

export interface TournamentTheme {
  // Identity
  label: string;       // display name (may differ from tournament.name)
  venue: string;       // venue tagline shown in hero
  icon: string;        // emoji icon

  // Primary accent color (replaces royal blue in active states)
  accent: string;      // e.g. #006747
  accentMid: string;   // slightly lighter variant for text/icons
  accentLight: string; // subtle tint for backgrounds

  // Hero section
  heroBg: string;            // gradient for the hero card background
  heroPatternColor: string;  // color of the subtle stripe overlay
  heroGlow: string;          // box-shadow glow

  // Card borders & glows
  cardBorder: string;        // rgba border for themed cards
  cardGlow: string;          // box-shadow for themed cards

  // Active UI states (buttons, tabs)
  activeBg: string;          // background when active
  activeBorder: string;      // border color when active
  activeText: string;        // text color when active
}

// ─── Theme definitions ────────────────────────────────────────────────────────

const THEMES: Record<string, TournamentTheme> = {

  // ── The Masters — Augusta National ────────────────────────────────────────
  // Signature Augusta green with elegant dark forest backdrop.
  // Colors match the Masters Tournament logo and broadcast graphics.
  'masters': {
    label:   'THE MASTERS',
    venue:   'Augusta National Golf Club',
    icon:    '⛳',
    accent:      '#006747',
    accentMid:   '#2D9E6B',
    accentLight: 'rgba(0, 103, 71, 0.15)',
    heroBg: 'linear-gradient(160deg, #001810 0%, #003525 45%, #001A10 100%)',
    heroPatternColor: 'rgba(0, 103, 71, 0.12)',
    heroGlow: '0 8px 48px rgba(0, 103, 71, 0.35)',
    cardBorder: 'rgba(0, 103, 71, 0.45)',
    cardGlow:   '0 0 32px rgba(0, 103, 71, 0.2)',
    activeBg:     'rgba(0, 103, 71, 0.25)',
    activeBorder: '#006747',
    activeText:   '#2D9E6B',
  },

  // ── The Players Championship — TPC Sawgrass ───────────────────────────────
  // Ocean water blue of Pete Dye's island green 17th hole.
  'players-championship': {
    label:   'THE PLAYERS',
    venue:   'TPC Sawgrass · Stadium Course',
    icon:    '🏝️',
    accent:      '#1B4F8A',
    accentMid:   '#3D80C0',
    accentLight: 'rgba(27, 79, 138, 0.15)',
    heroBg: 'linear-gradient(160deg, #020E20 0%, #0A2540 45%, #020E20 100%)',
    heroPatternColor: 'rgba(27, 79, 138, 0.12)',
    heroGlow: '0 8px 48px rgba(27, 79, 138, 0.35)',
    cardBorder: 'rgba(27, 79, 138, 0.45)',
    cardGlow:   '0 0 32px rgba(27, 79, 138, 0.2)',
    activeBg:     'rgba(27, 79, 138, 0.25)',
    activeBorder: '#1B4F8A',
    activeText:   '#3D80C0',
  },

  // ── PGA Championship — Wanamaker Trophy ──────────────────────────────────
  // Deep charcoal and Wanamaker gold — power and prestige.
  'pga-championship': {
    label:   'PGA CHAMPIONSHIP',
    venue:   'Quail Hollow Club',
    icon:    '🏆',
    accent:      '#B8922A',
    accentMid:   '#D4AF37',
    accentLight: 'rgba(184, 146, 42, 0.15)',
    heroBg: 'linear-gradient(160deg, #0D0B06 0%, #1E1A08 45%, #0D0B06 100%)',
    heroPatternColor: 'rgba(184, 146, 42, 0.08)',
    heroGlow: '0 8px 48px rgba(184, 146, 42, 0.3)',
    cardBorder: 'rgba(184, 146, 42, 0.45)',
    cardGlow:   '0 0 32px rgba(184, 146, 42, 0.2)',
    activeBg:     'rgba(184, 146, 42, 0.2)',
    activeBorder: '#B8922A',
    activeText:   '#D4AF37',
  },

  // ── U.S. Open — USGA ─────────────────────────────────────────────────────
  // USGA red — demanding, relentless, American.
  'us-open': {
    label:   'U.S. OPEN',
    venue:   'Oakmont Country Club',
    icon:    '🇺🇸',
    accent:      '#9B1C2E',
    accentMid:   '#C0394D',
    accentLight: 'rgba(155, 28, 46, 0.15)',
    heroBg: 'linear-gradient(160deg, #150308 0%, #280510 45%, #150308 100%)',
    heroPatternColor: 'rgba(155, 28, 46, 0.12)',
    heroGlow: '0 8px 48px rgba(155, 28, 46, 0.35)',
    cardBorder: 'rgba(155, 28, 46, 0.45)',
    cardGlow:   '0 0 32px rgba(155, 28, 46, 0.2)',
    activeBg:     'rgba(155, 28, 46, 0.25)',
    activeBorder: '#9B1C2E',
    activeText:   '#C0394D',
  },

  // ── The Open Championship — Claret Jug ───────────────────────────────────
  // Deep Royal & Ancient navy — timeless, windswept links golf.
  'the-open': {
    label:   'THE OPEN CHAMPIONSHIP',
    venue:   'Royal Portrush Golf Club',
    icon:    '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
    accent:      '#00337F',
    accentMid:   '#1A5BB5',
    accentLight: 'rgba(0, 51, 127, 0.15)',
    heroBg: 'linear-gradient(160deg, #000A1A 0%, #001840 45%, #000A1A 100%)',
    heroPatternColor: 'rgba(0, 51, 127, 0.12)',
    heroGlow: '0 8px 48px rgba(0, 51, 127, 0.35)',
    cardBorder: 'rgba(0, 51, 127, 0.45)',
    cardGlow:   '0 0 32px rgba(0, 51, 127, 0.2)',
    activeBg:     'rgba(0, 51, 127, 0.25)',
    activeBorder: '#00337F',
    activeText:   '#1A5BB5',
  },
};

// Default fallback (Warriors navy/gold)
const DEFAULT_THEME: TournamentTheme = {
  label:   'TOURNAMENT',
  venue:   '',
  icon:    '⛳',
  accent:      '#006BB6',
  accentMid:   '#3D95CC',
  accentLight: 'rgba(0, 107, 182, 0.15)',
  heroBg: 'linear-gradient(160deg, #030912 0%, #0A1628 45%, #030912 100%)',
  heroPatternColor: 'rgba(0, 107, 182, 0.08)',
  heroGlow: '0 8px 48px rgba(0, 107, 182, 0.25)',
  cardBorder: 'rgba(0, 107, 182, 0.4)',
  cardGlow:   '0 0 32px rgba(0, 107, 182, 0.15)',
  activeBg:     'rgba(0, 107, 182, 0.2)',
  activeBorder: '#006BB6',
  activeText:   '#3D95CC',
};

export function getTournamentTheme(tournamentId: string): TournamentTheme {
  return THEMES[tournamentId] ?? DEFAULT_THEME;
}
