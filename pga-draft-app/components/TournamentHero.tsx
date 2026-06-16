// ─── Tournament Hero Banner ───────────────────────────────────────────────────
// Immersive, per-tournament header used at the top of the draft room and
// leaderboard pages. Each tournament gets its official color palette.

import React from 'react';
import type { TournamentTheme } from '@/lib/tournament-theme';

interface Props {
  theme: TournamentTheme;
  year: number;
  subtitle?: string;
  rightSlot?: React.ReactNode;
}

// ─── Inline SVG decals ────────────────────────────────────────────────────────
// Purely decorative — large, transparent watermarks in the hero background.

function FlagPinDecal({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 120 160" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width: '100%', height: '100%' }}>
      {/* Flag pole */}
      <rect x="55" y="10" width="4" height="120" rx="2" fill={color} />
      {/* Flag */}
      <path d="M59 14 L59 60 L95 46 L59 32 Z" fill={color} />
      {/* Ground mound */}
      <ellipse cx="57" cy="138" rx="28" ry="10" fill={color} opacity="0.6" />
      {/* Hole */}
      <ellipse cx="57" cy="138" rx="12" ry="4" fill={color} opacity="0.3" />
    </svg>
  );
}

function TrophyDecal({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 120 160" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width: '100%', height: '100%' }}>
      {/* Cup body */}
      <path d="M35 20 L85 20 L78 75 Q78 95 60 98 Q42 95 42 75 Z" fill={color} />
      {/* Handles */}
      <path d="M35 28 Q18 28 18 55 Q18 72 42 72" stroke={color} strokeWidth="5" fill="none" />
      <path d="M85 28 Q102 28 102 55 Q102 72 78 72" stroke={color} strokeWidth="5" fill="none" />
      {/* Stem */}
      <rect x="54" y="98" width="12" height="28" rx="2" fill={color} />
      {/* Base */}
      <rect x="38" y="126" width="44" height="10" rx="4" fill={color} />
      {/* Stars */}
      <text x="60" y="55" textAnchor="middle" fill={color} fontSize="18" opacity="0.5">★</text>
    </svg>
  );
}

function EagleDecal({ color }: { color: string }) {
  // Stylized eagle head silhouette — US Open / American golf
  return (
    <svg viewBox="0 0 140 160" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width: '100%', height: '100%' }}>
      {/* Wing left */}
      <path d="M10 90 Q30 50 65 70 Q40 80 30 100 Z" fill={color} />
      {/* Wing right */}
      <path d="M130 90 Q110 50 75 70 Q100 80 110 100 Z" fill={color} />
      {/* Body */}
      <ellipse cx="70" cy="95" rx="22" ry="32" fill={color} />
      {/* Head */}
      <circle cx="70" cy="58" r="18" fill={color} />
      {/* Beak */}
      <path d="M86 58 L100 63 L86 68 Z" fill={color} opacity="0.7" />
      {/* Eye */}
      <circle cx="80" cy="56" r="3" fill={color} opacity="0.3" />
      {/* Talons */}
      <path d="M56 126 Q50 138 42 140 M70 128 Q70 140 70 144 M84 126 Q90 138 98 140" stroke={color} strokeWidth="3" strokeLinecap="round" fill="none" />
      {/* Stars row */}
      <text x="70" y="152" textAnchor="middle" fill={color} fontSize="11" letterSpacing="8" opacity="0.55">★ ★ ★</text>
    </svg>
  );
}

function LighthouseDecal({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 100 170" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width: '100%', height: '100%' }}>
      {/* Light beams */}
      <path d="M50 40 L10 10" stroke={color} strokeWidth="2" opacity="0.4" />
      <path d="M50 40 L90 10" stroke={color} strokeWidth="2" opacity="0.4" />
      <path d="M50 40 L0 40" stroke={color} strokeWidth="1.5" opacity="0.25" />
      {/* Lantern room */}
      <rect x="36" y="35" width="28" height="22" rx="3" fill={color} />
      {/* Light */}
      <circle cx="50" cy="46" r="7" fill={color} opacity="0.5" />
      {/* Tower */}
      <path d="M38 57 L44 140 L56 140 L62 57 Z" fill={color} />
      {/* Stripes */}
      <path d="M39 75 L61 75 L60 85 L40 85 Z" fill={color} opacity="0.3" />
      <path d="M41 100 L59 100 L58 110 L42 110 Z" fill={color} opacity="0.3" />
      {/* Base */}
      <rect x="30" y="140" width="40" height="10" rx="3" fill={color} />
      {/* Waves */}
      <path d="M15 155 Q25 150 35 155 Q45 160 55 155 Q65 150 75 155 Q85 160 95 155" stroke={color} strokeWidth="2" fill="none" opacity="0.5" />
    </svg>
  );
}

function ClaretJugDecal({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 110 170" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width: '100%', height: '100%' }}>
      {/* Jug body */}
      <path d="M35 50 Q28 50 26 65 L20 125 Q20 140 55 140 Q90 140 90 125 L84 65 Q82 50 75 50 Z" fill={color} />
      {/* Neck */}
      <rect x="40" y="28" width="30" height="25" rx="4" fill={color} />
      {/* Lid */}
      <ellipse cx="55" cy="28" rx="18" ry="6" fill={color} />
      <rect x="49" y="16" width="12" height="14" rx="3" fill={color} />
      {/* Handle */}
      <path d="M84 65 Q105 65 105 90 Q105 115 84 110" stroke={color} strokeWidth="8" fill="none" strokeLinecap="round" />
      {/* Spout */}
      <path d="M26 70 Q5 65 8 85 Q10 95 26 90" stroke={color} strokeWidth="6" fill="none" strokeLinecap="round" />
      {/* Band engravings */}
      <rect x="22" y="90" width="66" height="6" rx="1" fill={color} opacity="0.35" />
      <rect x="22" y="110" width="66" height="6" rx="1" fill={color} opacity="0.35" />
      {/* Base */}
      <rect x="28" y="140" width="54" height="12" rx="4" fill={color} />
    </svg>
  );
}

function HeroDecal({ type, color }: { type: TournamentTheme['heroDecal']; color: string }) {
  switch (type) {
    case 'flag-pin':   return <FlagPinDecal color={color} />;
    case 'trophy':     return <TrophyDecal color={color} />;
    case 'eagle':      return <EagleDecal color={color} />;
    case 'lighthouse': return <LighthouseDecal color={color} />;
    case 'claret-jug': return <ClaretJugDecal color={color} />;
    default:           return null;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TournamentHero({ theme, year, subtitle, rightSlot }: Props) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl mb-5"
      style={{
        background: theme.heroBg,
        border: `1px solid ${theme.cardBorder}`,
        boxShadow: theme.heroGlow,
      }}
    >
      {/* Top accent line */}
      <div
        className="h-0.5 absolute top-0 left-0 right-0"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${theme.accent} 30%, ${theme.accentMid} 70%, transparent 100%)`,
        }}
      />

      {/* Diagonal stripe texture */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `repeating-linear-gradient(
            -55deg,
            ${theme.heroPatternColor} 0px,
            ${theme.heroPatternColor} 1px,
            transparent 1px,
            transparent 14px
          )`,
        }}
      />

      {/* Radial bloom — accent color from top-right */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 60% 75% at 90% 5%, ${theme.accentLight} 0%, transparent 70%)`,
        }}
      />

      {/* Secondary bloom from bottom-left */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 40% 50% at 5% 110%, ${theme.accentLight} 0%, transparent 70%)`,
        }}
      />

      {/* Logo bloom */}
      {theme.logoPath && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(ellipse 45% 80% at 100% 0%, rgba(232,201,74,0.10) 0%, transparent 65%)`,
          }}
        />
      )}

      {/* Decorative SVG decal — right-side watermark */}
      {!theme.logoPath && theme.heroDecal && (
        <div
          className="absolute pointer-events-none select-none"
          style={{
            right: '-8px',
            top: '-8px',
            width: '120px',
            height: '160px',
            opacity: 0.07,
          }}
        >
          <HeroDecal type={theme.heroDecal} color={theme.accentMid} />
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 px-5 pt-5 pb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Venue tagline */}
          {theme.venue && (
            <div className="flex items-center gap-2 mb-1.5">
              {!theme.logoPath && <span className="text-sm leading-none">{theme.icon}</span>}
              <span
                className="text-xs font-semibold tracking-[0.18em] uppercase"
                style={{ color: theme.accentMid }}
              >
                {theme.venue}
              </span>
            </div>
          )}

          {/* Tournament name */}
          <h1
            className="font-bebas leading-none tracking-widest text-white"
            style={{ fontSize: 'clamp(2rem, 7vw, 3.25rem)' }}
          >
            {theme.label}
          </h1>

          {/* Location + dates row */}
          {(theme.location || theme.dates) && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {theme.location && (
                <span
                  className="text-xs font-medium tracking-wide"
                  style={{ color: `${theme.accentMid}99` }}
                >
                  📍 {theme.location}
                </span>
              )}
              {theme.location && theme.dates && (
                <span style={{ color: `${theme.accentMid}44` }} className="text-xs">·</span>
              )}
              {theme.dates && (
                <span
                  className="text-xs font-medium tracking-wide"
                  style={{ color: `${theme.accentMid}99` }}
                >
                  🗓 {theme.dates}
                </span>
              )}
            </div>
          )}

          {/* Draft info subtitle */}
          {subtitle && (
            <p className="text-sm mt-1.5 font-medium" style={{ color: `${theme.accentMid}CC` }}>
              {subtitle}
            </p>
          )}
        </div>

        {/* Right: logo or year watermark */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          {rightSlot}
          {theme.logoPath ? (
            <img
              src={theme.logoPath}
              alt={theme.label}
              className="w-auto object-contain select-none"
              style={{
                height: 'clamp(64px, 11vw, 96px)',
                filter: 'drop-shadow(0 4px 20px rgba(0,0,0,0.7)) drop-shadow(0 0 8px rgba(0,0,0,0.5))',
              }}
              draggable={false}
            />
          ) : (
            <div className="flex flex-col items-end select-none" style={{ color: `${theme.accentMid}1A` }}>
              <span
                className="font-bebas tracking-widest leading-none"
                style={{ fontSize: 'clamp(3rem, 10vw, 5rem)' }}
              >
                {year}
              </span>
              <span
                className="font-bebas tracking-[0.3em] text-xs uppercase mt-0.5"
                style={{ color: `${theme.accentMid}33` }}
              >
                Warrior Cup
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Bottom accent line */}
      <div
        className="h-px"
        style={{
          background: `linear-gradient(90deg, ${theme.accent}44 0%, ${theme.accent}88 50%, ${theme.accent}44 100%)`,
        }}
      />
    </div>
  );
}
