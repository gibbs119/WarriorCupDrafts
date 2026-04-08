'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import { getAllTournaments, getAllDailySummaries, getDraftGrades } from '@/lib/db';
import { getTournamentTheme } from '@/lib/tournament-theme';
import TournamentAudio from '@/components/TournamentAudio';
import { TOURNAMENTS } from '@/lib/constants';
import type { Tournament } from '@/lib/types';
import React from 'react';
import {
  Trophy, TrendingUp, TrendingDown, ChevronDown, ChevronUp,
  Sparkles, BookOpen, Calendar,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DailySummary {
  tournamentId: string;
  tournamentName: string;
  date: string;
  dayLabel: string;
  standingsBreakdown: string;
  heroName: string;
  heroTeam: string;
  heroSummary: string;
  zeroName: string;
  zeroTeam: string;
  zeroSummary: string;
  outlook: string;
  generatedAt: number;
}

interface DraftGrade {
  userId: string;
  username: string;
  grade: string;
  winPct: number;
  summary: string;
  generatedAt: number;
}

// ─── Grade colors (matches DraftGradesPanel) ─────────────────────────────────

const GRADE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  'A+': { bg: 'rgba(201,162,39,0.2)',  border: 'rgba(201,162,39,0.5)',  text: '#D4AF37' },
  'A':  { bg: 'rgba(201,162,39,0.15)', border: 'rgba(201,162,39,0.4)',  text: '#D4AF37' },
  'A-': { bg: 'rgba(201,162,39,0.12)', border: 'rgba(201,162,39,0.35)', text: '#C9A227' },
  'B+': { bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.35)',  text: '#4ade80' },
  'B':  { bg: 'rgba(34,197,94,0.10)',  border: 'rgba(34,197,94,0.3)',   text: '#4ade80' },
  'B-': { bg: 'rgba(34,197,94,0.08)',  border: 'rgba(34,197,94,0.25)',  text: '#86efac' },
  'C+': { bg: 'rgba(0,107,182,0.15)',  border: 'rgba(0,107,182,0.4)',   text: '#60a5fa' },
  'C':  { bg: 'rgba(0,107,182,0.12)',  border: 'rgba(0,107,182,0.3)',   text: '#60a5fa' },
  'C-': { bg: 'rgba(0,107,182,0.10)',  border: 'rgba(0,107,182,0.25)',  text: '#93c5fd' },
  'D':  { bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.35)', text: '#fb923c' },
  'F':  { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.35)',  text: '#f87171' },
};
function gradeStyle(g: string) { return GRADE_COLORS[g] ?? GRADE_COLORS['C']; }

// ─── Sub-components ───────────────────────────────────────────────────────────

function DailySummaryCard({ summary }: { summary: DailySummary }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>

      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex items-center gap-2.5">
          <Calendar size={14} style={{ color: '#C9A227' }} />
          <span className="font-bebas text-lg tracking-wider text-white">{summary.dayLabel}</span>
          <span className="text-slate-500 text-xs">{summary.date}</span>
        </div>
        {open
          ? <ChevronUp size={15} className="text-slate-500" />
          : <ChevronDown size={15} className="text-slate-500" />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          <div className="h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />

          {/* Standings breakdown */}
          <div className="rounded-xl p-3.5"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="flex items-center gap-2 mb-2">
              <Trophy size={12} style={{ color: '#C9A227' }} />
              <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#C9A227' }}>
                Standings
              </span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{summary.standingsBreakdown}</p>
          </div>

          {/* Hero & Zero */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-3"
              style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <TrendingUp size={12} className="text-green-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-green-400">Hero</span>
              </div>
              <p className="text-white font-bold text-sm leading-tight">{summary.heroName}</p>
              <p className="text-xs text-green-400/70 mb-1.5">{summary.heroTeam}&apos;s pick</p>
              <p className="text-xs text-slate-400 leading-relaxed">{summary.heroSummary}</p>
            </div>
            <div className="rounded-xl p-3"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <TrendingDown size={12} className="text-red-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-red-400">Zero</span>
              </div>
              <p className="text-white font-bold text-sm leading-tight">{summary.zeroName}</p>
              <p className="text-xs text-red-400/70 mb-1.5">{summary.zeroTeam}&apos;s pick</p>
              <p className="text-xs text-slate-400 leading-relaxed">{summary.zeroSummary}</p>
            </div>
          </div>

          {/* Outlook */}
          <div className="rounded-xl p-3.5"
            style={{ background: 'rgba(0,107,182,0.1)', border: '1px solid rgba(0,107,182,0.25)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs">🔭</span>
              <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#60a5fa' }}>
                Outlook
              </span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{summary.outlook}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function DraftGradeCard({ grade, isMe }: { grade: DraftGrade; isMe: boolean }) {
  const [open, setOpen] = useState(false);
  const style = gradeStyle(grade.grade);

  return (
    <div className="rounded-xl overflow-hidden transition-all"
      style={{
        background: style.bg,
        border: `1.5px solid ${style.border}`,
        outline: isMe ? `2px solid ${style.border}` : 'none',
        outlineOffset: '2px',
      }}>
      <button className="w-full flex items-center gap-3 px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}>
        <div className="flex items-center justify-center w-11 h-11 rounded-xl font-bebas text-2xl leading-none shrink-0"
          style={{ background: 'rgba(0,0,0,0.25)', color: style.text }}>
          {grade.grade}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-white text-sm">{grade.username}</span>
            {isMe && (
              <span className="text-xs px-1.5 py-0.5 rounded font-bold"
                style={{ background: style.border, color: '#030912' }}>YOU</span>
            )}
          </div>
          <div className="text-xs mt-0.5 flex items-center gap-2" style={{ color: style.text }}>
            {grade.winPct}% chance to win
            <span className="inline-block w-16 h-1.5 rounded-full align-middle"
              style={{ background: 'rgba(0,0,0,0.3)' }}>
              <span className="block h-full rounded-full"
                style={{ width: `${grade.winPct}%`, background: style.text }} />
            </span>
          </div>
        </div>
        <ChevronDown size={15} className="text-slate-500 shrink-0 transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <div className="px-4 pb-4">
          <div className="h-px mb-3" style={{ background: style.border + '60' }} />
          <p className="text-sm text-slate-300 leading-relaxed">{grade.summary}</p>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface TournamentRecaps {
  tournament: Tournament;
  summaries: DailySummary[];
  grades: DraftGrade[];
}

export default function RecapsPage() {
  const { appUser, loading } = useAuth();
  const router = useRouter();
  const [recaps, setRecaps] = useState<TournamentRecaps[]>([]);
  const [fetching, setFetching] = useState(true);
  const [activeTournament, setActiveTournament] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      try {
        const tournaments = await getAllTournaments();
        const order = TOURNAMENTS.map((t) => t.id);
        tournaments.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

        // Only show tournaments that have had a draft (active or completed)
        const relevant = tournaments.filter(
          (t) => t.status === 'active' || t.status === 'completed' || t.draftComplete
        );

        const results = await Promise.all(
          relevant.map(async (t) => {
            const [summariesResult, gradesResult] = await Promise.allSettled([
              getAllDailySummaries(t.id),
              getDraftGrades(t.id),
            ]);
            return {
              tournament: t,
              summaries: summariesResult.status === 'fulfilled' ? summariesResult.value as DailySummary[] : [],
              grades: gradesResult.status === 'fulfilled' ? gradesResult.value as DraftGrade[] : [],
            };
          })
        );

        // Only include tournaments that have at least one summary or grade
        const withContent = results.filter((r) => r.summaries.length > 0 || r.grades.length > 0);
        setRecaps(withContent);

        // Auto-expand the first tournament (most recent active)
        if (withContent.length > 0) {
          setActiveTournament(withContent[0].tournament.id);
        }
      } finally {
        setFetching(false);
      }
    }
    load();
  }, [appUser]);

  if (loading || !appUser) {
    return (
      <div className="min-h-screen page">
        <Navigation />
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          <div className="skeleton h-10 w-56 rounded-xl mb-4" />
          {[1,2,3].map(i => <div key={i} className="skeleton h-32 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen page">
      <Navigation />

      <main className="max-w-3xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2.5 mb-1">
            <BookOpen size={20} style={{ color: '#C9A227' }} />
            <h1 className="font-bebas text-3xl tracking-wider text-white">RECAPS &amp; REPORT CARDS</h1>
          </div>
          <p className="text-slate-400 text-sm">Daily round summaries and draft grades for every tournament.</p>
        </div>

        {fetching ? (
          <div className="text-center py-16 text-slate-500">
            <p className="font-bebas text-xl tracking-widest animate-pulse" style={{ color: '#C9A227' }}>Loading…</p>
          </div>
        ) : recaps.length === 0 ? (
          <div className="text-center py-16 rounded-2xl"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <p className="text-4xl mb-3">⛳</p>
            <p className="font-bebas text-xl tracking-wider text-white mb-2">Nothing here yet</p>
            <p className="text-slate-400 text-sm max-w-xs mx-auto">
              Round recaps appear automatically after each day of play. Draft report cards are generated once the draft is complete.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {recaps.map(({ tournament, summaries, grades }) => {
              const isActive = activeTournament === tournament.id;
              const tTheme = getTournamentTheme(tournament.id);

              return (
                <div key={tournament.id}>
                  {/* Tournament ambient audio — plays when this section is expanded */}
                  {isActive && tTheme.musicUrl && (
                    <TournamentAudio
                      trackUrl={tTheme.musicUrl}
                      label={`${tTheme.label} Theme`}
                      accent={tTheme.accent}
                      accentMid={tTheme.accentMid}
                    />
                  )}

                  {/* Tournament header toggle */}
                  <button
                    className="w-full flex items-center justify-between mb-4 group rounded-2xl px-4 py-3 transition-all"
                    style={{
                      background: isActive ? tTheme.accentLight : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isActive ? tTheme.cardBorder : 'rgba(255,255,255,0.06)'}`,
                    }}
                    onClick={() => setActiveTournament(isActive ? null : tournament.id)}
                  >
                    <div className="flex items-center gap-3">
                      {/* Tournament logo (small) or accent line */}
                      {tTheme.logoPath ? (
                        <img
                          src={tTheme.logoPath}
                          alt={tTheme.label}
                          className="w-auto object-contain shrink-0"
                          style={{ height: '36px', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))' }}
                          draggable={false}
                        />
                      ) : (
                        <div className="h-6 w-1 rounded-full shrink-0"
                          style={{ background: tTheme.accent }} />
                      )}
                      <h2 className="font-bebas text-2xl tracking-wider text-white transition-colors"
                        style={{ color: isActive ? tTheme.accentMid : '#fff' }}>
                        {tournament.name}
                      </h2>
                      <span className="text-slate-500 text-xs font-mono">{tournament.year}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                        tournament.status === 'active'
                          ? 'bg-green-900/50 text-green-400 border border-green-800'
                          : 'bg-slate-800 text-slate-500 border border-slate-700'
                      }`}>
                        {tournament.status === 'active' ? 'LIVE' : tournament.status.toUpperCase()}
                      </span>
                    </div>
                    {isActive
                      ? <ChevronUp size={16} className="text-slate-500 shrink-0" />
                      : <ChevronDown size={16} className="text-slate-500 shrink-0" />}
                  </button>

                  {isActive && (
                    <div className="space-y-6">

                      {/* Draft Report Cards */}
                      {grades.length > 0 && (
                        <section>
                          <div className="flex items-center gap-2 mb-3">
                            <Sparkles size={14} style={{ color: tTheme.accentMid }} />
                            <h3 className="font-bebas text-lg tracking-wider text-white">Draft Report Cards</h3>
                            <span className="text-slate-600 text-xs">— generated after draft</span>
                          </div>
                          <div className="space-y-2">
                            {([...grades] as DraftGrade[])
                              .sort((a, b) => b.winPct - a.winPct)
                              .map((g: DraftGrade) => (
                                <React.Fragment key={g.userId}>
                                  <DraftGradeCard grade={g} isMe={g.userId === appUser.uid} />
                                </React.Fragment>
                              ))}
                          </div>
                        </section>
                      )}

                      {/* Daily Recaps */}
                      {summaries.length > 0 && (
                        <section>
                          <div className="flex items-center gap-2 mb-3">
                            <Calendar size={14} style={{ color: tTheme.accentMid }} />
                            <h3 className="font-bebas text-lg tracking-wider text-white">Round Recaps</h3>
                            <span className="text-slate-600 text-xs">— {summaries.length} round{summaries.length !== 1 ? 's' : ''}</span>
                          </div>
                          <div className="space-y-3">
                            {(summaries as DailySummary[]).map((s: DailySummary) => (
                              <React.Fragment key={s.date}>
                                <DailySummaryCard summary={s} />
                              </React.Fragment>
                            ))}
                          </div>
                        </section>
                      )}

                      {grades.length === 0 && summaries.length === 0 && (
                        <p className="text-slate-500 text-sm italic px-1">No recaps generated yet for this tournament.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
