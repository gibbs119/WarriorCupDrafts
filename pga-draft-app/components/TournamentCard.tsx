'use client';

import Link from 'next/link';
import type { Tournament } from '@/lib/types';
import { Calendar, ChevronRight, BookOpen } from 'lucide-react';

const TOURNAMENT_ICONS: Record<string, string> = {
  'players-championship': '🏖️',
  'masters':              '🌸',
  'pga-championship':     '🏆',
  'us-open':              '🇺🇸',
  'the-open':             '⛳',
};

const STATUS_CONFIG: Record<string, { pill: string; label: string }> = {
  upcoming:  { pill: 'pill-upcoming', label: 'Upcoming'   },
  drafting:  { pill: 'pill-draft',    label: 'Draft Open' },
  active:    { pill: 'pill-live',     label: 'Live'       },
  completed: { pill: 'pill-final',    label: 'Final'      },
};

export default function TournamentCard({ tournament }: { tournament: Tournament }) {
  const icon   = TOURNAMENT_ICONS[tournament.id] ?? '⛳';
  const config = STATUS_CONFIG[tournament.status];

  const draftHref =
    (tournament.status === 'drafting' || tournament.status === 'active' || tournament.status === 'completed')
      ? `/draft/${tournament.id}` : null;

  const leaderboardHref =
    (tournament.status === 'active' || tournament.status === 'completed')
      ? `/leaderboard/${tournament.id}` : null;

  const isActive = tournament.status === 'active' || tournament.status === 'drafting';

  return (
    <div className={`card transition-all hover:border-white/15 ${isActive ? 'glow-royal' : ''}`}
      style={isActive ? { borderColor: 'rgba(0,107,182,0.4)' } : {}}>

      {/* Live pulse for active tournaments */}
      {tournament.status === 'active' && (
        <div className="flex items-center gap-1.5 mb-3">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-xs font-bold text-green-400 uppercase tracking-wider">Live Now</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-3">
          <span className="text-2xl mt-0.5">{icon}</span>
          <div>
            <h3 className="font-bebas text-xl tracking-wider text-white leading-none">{tournament.name}</h3>
            <p className="text-slate-500 text-xs flex items-center gap-1 mt-1">
              <Calendar size={10} />
              {tournament.startDate}
            </p>
          </div>
        </div>
        <span className={config.pill}>{config.label}</span>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 text-xs mb-4" style={{ color: 'rgba(148,163,184,0.7)' }}>
        <span>{tournament.fieldSize > 0 ? `${tournament.fieldSize} players` : 'Field TBD'}</span>
        <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
        <span>{tournament.maxPicks} picks / team</span>
        {tournament.draftComplete && (
          <>
            <span style={{ color: 'rgba(255,255,255,0.15)' }}>·</span>
            <span style={{ color: '#C9A227' }}>✓ Draft complete</span>
          </>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        {draftHref && (
          <Link href={draftHref}
            className="btn-primary text-sm py-1.5 px-3">
            {tournament.status === 'drafting' ? '📋 Draft Room' : '📋 View Draft'}
            <ChevronRight size={13} />
          </Link>
        )}
        {leaderboardHref && (
          <Link href={leaderboardHref}
            className="btn-gold text-sm py-1.5 px-3">
            🏅 Leaderboard
            <ChevronRight size={13} />
          </Link>
        )}
        {!draftHref && !leaderboardHref && (
          <p className="text-xs italic" style={{ color: 'rgba(148,163,184,0.5)' }}>
            Draft will open closer to tournament week
          </p>
        )}
        {/* Recaps link when draft is complete (grades + daily summaries) */}
        {tournament.draftComplete && (
          <Link href="/recaps"
            className="btn-secondary text-sm py-1.5 px-3 flex items-center gap-1.5">
            <BookOpen size={12} /> Recaps
          </Link>
        )}
        {/* WD replacement link when tournament is active and draft is done */}
        {tournament.status === 'active' && tournament.draftComplete && (
          <Link href={`/wd/${tournament.id}`}
            className="btn-secondary text-sm py-1.5 px-3">
            ⚠ WD Replacement
          </Link>
        )}
      </div>
    </div>
  );
}
