// ─── Tournament Hero Banner ───────────────────────────────────────────────────
// Immersive, per-tournament header used at the top of the draft room and
// leaderboard pages. Each tournament gets its official color palette.

import React from 'react';
import type { TournamentTheme } from '@/lib/tournament-theme';

interface Props {
  theme: TournamentTheme;
  year: number;
  subtitle?: string;   // e.g. "Snake Draft · 4 picks/team · 91 player field"
  rightSlot?: React.ReactNode; // e.g. refresh button or live indicator
}

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
      {/* Top accent line — tournament color */}
      <div
        className="h-0.5 absolute top-0 left-0 right-0"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${theme.accent} 30%, ${theme.accentMid} 70%, transparent 100%)`,
        }}
      />

      {/* Subtle diagonal stripe pattern — adds texture without needing images */}
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

      {/* Radial bloom glow — accent color emanating from top-right */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 55% 70% at 90% 10%, ${theme.accentLight} 0%, transparent 70%)`,
        }}
      />

      {/* Golden bloom from top-right when logo is present */}
      {theme.logoPath && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(ellipse 45% 80% at 100% 0%, rgba(232,201,74,0.10) 0%, transparent 65%)`,
          }}
        />
      )}

      {/* Content */}
      <div className="relative z-10 px-5 pt-5 pb-4 flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Venue tagline */}
          {theme.venue && (
            <div className="flex items-center gap-2 mb-2">
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

          {/* Subtitle */}
          {subtitle && (
            <p className="text-sm mt-1.5 font-medium" style={{ color: `${theme.accentMid}CC` }}>
              {subtitle}
            </p>
          )}
        </div>

        {/* Right slot — logo (preferred) or year watermark */}
        <div className="flex flex-col items-end gap-2 shrink-0">
          {rightSlot}
          {theme.logoPath ? (
            /* Official tournament logo */
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
            /* Fallback: year watermark */
            <span
              className="font-bebas tracking-widest leading-none select-none hidden sm:block"
              style={{ fontSize: '3.5rem', color: 'rgba(255,255,255,0.07)' }}
            >
              {year}
            </span>
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
