'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { getLatestDailySummary, markSummarySeen } from '@/lib/db';
import { X, TrendingUp, TrendingDown, Trophy } from 'lucide-react';

interface DailySummaryData {
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
  seen: Record<string, boolean>;
  isFinalRound?: boolean;
  tournamentJourney?: string;
  chartAnalysis?: string;
  draftReportCard?: string;
}

interface Props {
  tournamentId: string | null;
}

export default function DailySummaryModal({ tournamentId }: Props) {
  const { appUser, isViewMode } = useAuth();
  const [summary, setSummary] = useState<DailySummaryData | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!tournamentId || !appUser || isViewMode) return;

    async function checkForSummary() {
      const data = await getLatestDailySummary(tournamentId!);
      if (!data) return;
      const s = data as DailySummaryData;
      // Only show if this user hasn't dismissed it yet
      if (!s.seen?.[appUser!.uid]) {
        setSummary(s);
        setVisible(true);
      }
    }

    checkForSummary();
  }, [tournamentId, appUser]);

  async function handleDismiss() {
    setVisible(false);
    if (!summary || !appUser) return;
    await markSummarySeen(summary.tournamentId, summary.date, appUser.uid);
  }

  if (!visible || !summary) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}>

      <div className="w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl"
        style={{ background: '#0A1628', border: '1px solid rgba(201,162,39,0.4)', maxHeight: '90vh', overflowY: 'auto' }}>

        {/* Gold header bar */}
        <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, #A07A14, #C9A227, #D4B040, #C9A227, #A07A14)' }} />

        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-4 pb-3">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xl">⛳</span>
              <span className="font-bebas text-2xl tracking-widest text-white">{summary.tournamentName}</span>
            </div>
            <p className="font-bebas text-lg tracking-wider" style={{ color: '#C9A227' }}>
              {summary.dayLabel} · Daily Recap
            </p>
          </div>
          <button onClick={handleDismiss}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white transition-colors"
            style={{ background: 'rgba(255,255,255,0.06)' }}>
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-4">

          {/* Standings breakdown */}
          <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="flex items-center gap-2 mb-2">
              <Trophy size={14} style={{ color: '#C9A227' }} />
              <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#C9A227' }}>Standings Breakdown</span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{summary.standingsBreakdown}</p>
          </div>

          {/* Hero & Zero side by side */}
          <div className="grid grid-cols-2 gap-3">
            {/* Hero */}
            <div className="rounded-xl p-3.5" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
              <div className="flex items-center gap-1.5 mb-2">
                <TrendingUp size={13} className="text-green-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-green-400">Hero</span>
              </div>
              <p className="text-white font-bold text-sm leading-tight mb-0.5">{summary.heroName}</p>
              <p className="text-xs text-green-400/70 mb-2">{summary.heroTeam}'s pick</p>
              <p className="text-xs text-slate-400 leading-relaxed">{summary.heroSummary}</p>
            </div>

            {/* Zero */}
            <div className="rounded-xl p-3.5" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
              <div className="flex items-center gap-1.5 mb-2">
                <TrendingDown size={13} className="text-red-400" />
                <span className="text-xs font-bold uppercase tracking-widest text-red-400">Zero</span>
              </div>
              <p className="text-white font-bold text-sm leading-tight mb-0.5">{summary.zeroName}</p>
              <p className="text-xs text-red-400/70 mb-2">{summary.zeroTeam}'s pick</p>
              <p className="text-xs text-slate-400 leading-relaxed">{summary.zeroSummary}</p>
            </div>
          </div>

          {/* Outlook / Champion Verdict */}
          <div className="rounded-xl p-4" style={{ background: 'rgba(0,107,182,0.1)', border: '1px solid rgba(0,107,182,0.25)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs">{summary.isFinalRound ? '🏆' : '🔭'}</span>
              <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#60a5fa' }}>
                {summary.isFinalRound ? 'Champion Verdict' : 'Tournament Outlook'}
              </span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{summary.outlook}</p>
          </div>

          {/* Round 4 extended sections */}
          {summary.isFinalRound && summary.tournamentJourney && (
            <div className="rounded-xl p-4" style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.25)' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs">📈</span>
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#C9A227' }}>Tournament Journey</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{summary.tournamentJourney}</p>
            </div>
          )}

          {summary.isFinalRound && summary.chartAnalysis && (
            <div className="rounded-xl p-4" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs">📊</span>
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#a78bfa' }}>Score Chart Analysis</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{summary.chartAnalysis}</p>
            </div>
          )}

          {summary.isFinalRound && summary.draftReportCard && (
            <div className="rounded-xl p-4" style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs">📝</span>
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: '#4ade80' }}>Draft Report Card</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{summary.draftReportCard}</p>
            </div>
          )}

          <button onClick={handleDismiss}
            className="btn-gold w-full py-2.5 font-bebas tracking-widest text-base justify-center">
            {summary.isFinalRound ? 'SEE YOU NEXT MAJOR ⛳' : 'GOT IT — LET\'S GO ⛳'}
          </button>
        </div>
      </div>
    </div>
  );
}
