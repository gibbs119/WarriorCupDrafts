'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { getDraftGrades } from '@/lib/db';
import { Sparkles, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

interface DraftGrade {
  userId: string;
  username: string;
  grade: string;
  winPct: number;
  summary: string;
  generatedAt: number;
}

interface Props {
  tournamentId: string;
  draftComplete: boolean;
}

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

function gradeStyle(grade: string) {
  return GRADE_COLORS[grade] ?? GRADE_COLORS['C'];
}

export default function DraftGradesPanel({ tournamentId, draftComplete }: Props) {
  const { appUser } = useAuth();
  const [grades, setGrades] = useState<DraftGrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  useEffect(() => {
    if (!draftComplete) return;
    loadGrades();
  }, [tournamentId, draftComplete]);

  async function loadGrades() {
    setLoading(true);
    try {
      const data = await getDraftGrades(tournamentId);
      if (data && data.length > 0) {
        setGrades(data as DraftGrade[]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function generateGrades(force = false) {
    setGenerating(true);
    setError('');
    try {
      const res = await fetch('/api/ai/draft-grades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId, force }),
      });
      const data = await res.json();
      if (data.grades) {
        setGrades(data.grades);
        setExpanded(true);
      } else {
        setError(data.error ?? 'Generation failed');
      }
    } catch {
      setError('Network error — try again');
    } finally {
      setGenerating(false);
    }
  }

  if (!draftComplete) return null;

  // Sort: show my grade first, then by win %
  const myGrade = grades.find((g) => g.userId === appUser?.uid);
  const sorted = [
    ...(myGrade ? [myGrade] : []),
    ...grades.filter((g) => g.userId !== appUser?.uid).sort((a, b) => b.winPct - a.winPct),
  ];

  return (
    <div className="mb-6">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 group"
        >
          <Sparkles size={16} style={{ color: '#C9A227' }} />
          <span className="font-bebas text-xl tracking-wider text-white group-hover:text-yellow-300 transition-colors">
            AI DRAFT REPORT CARDS
          </span>
          {expanded
            ? <ChevronUp size={16} className="text-slate-400" />
            : <ChevronDown size={16} className="text-slate-400" />}
        </button>

        <div className="flex items-center gap-2">
          {grades.length === 0 && !loading && (
            <button
              onClick={() => generateGrades(false)}
              disabled={generating}
              className="btn-gold text-xs py-1.5 px-3 disabled:opacity-50"
            >
              {generating ? (
                <><RefreshCw size={11} className="animate-spin" /> Grading…</>
              ) : (
                <><Sparkles size={11} /> Generate Grades</>
              )}
            </button>
          )}
          {grades.length > 0 && appUser?.role === 'admin' && (
            <button
              onClick={() => generateGrades(true)}
              disabled={generating}
              className="btn-secondary text-xs py-1 px-2.5 disabled:opacity-50"
              title="Re-generate grades"
            >
              {generating ? <RefreshCw size={11} className="animate-spin" /> : <RefreshCw size={11} />}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="text-red-400 text-xs mb-3 px-1">{error}</p>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-slate-500 text-sm px-1">
          <RefreshCw size={13} className="animate-spin" />
          Loading grades…
        </div>
      )}

      {!expanded && grades.length > 0 && (
        /* Collapsed preview: just show grade pills */
        <div className="flex flex-wrap gap-2">
          {sorted.map((g) => {
            const style = gradeStyle(g.grade);
            const isMe = g.userId === appUser?.uid;
            return (
              <button
                key={g.userId}
                onClick={() => { setExpanded(true); setExpandedCard(g.userId); }}
                className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition-all"
                style={{
                  background: style.bg,
                  border: `1.5px solid ${style.border}`,
                  outline: isMe ? `2px solid ${style.border}` : 'none',
                  outlineOffset: '1px',
                }}
              >
                <span style={{ color: style.text }} className="font-bebas text-lg leading-none">{g.grade}</span>
                <span className="text-white">{g.username}</span>
                <span className="text-slate-400 text-xs">{g.winPct}%</span>
              </button>
            );
          })}
        </div>
      )}

      {expanded && grades.length > 0 && (
        <div className="space-y-3">
          {sorted.map((g) => {
            const style = gradeStyle(g.grade);
            const isMe = g.userId === appUser?.uid;
            const isOpen = expandedCard === g.userId || expandedCard === null;

            return (
              <div
                key={g.userId}
                className="rounded-xl overflow-hidden transition-all"
                style={{
                  background: style.bg,
                  border: `1.5px solid ${style.border}`,
                  outline: isMe ? `2px solid ${style.border}` : 'none',
                  outlineOffset: '2px',
                }}
              >
                <button
                  className="w-full flex items-center gap-3 px-4 py-3 text-left"
                  onClick={() => setExpandedCard(isOpen && expandedCard === g.userId ? null : g.userId)}
                >
                  {/* Grade badge */}
                  <div className="flex items-center justify-center w-12 h-12 rounded-xl font-bebas text-2xl leading-none shrink-0"
                    style={{ background: 'rgba(0,0,0,0.25)', color: style.text }}>
                    {g.grade}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-white text-sm">{g.username}</span>
                      {isMe && (
                        <span className="text-xs px-1.5 py-0.5 rounded font-bold"
                          style={{ background: style.border, color: '#030912' }}>YOU</span>
                      )}
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: style.text }}>
                      {g.winPct}% chance to win
                      {/* Win probability bar */}
                      <span className="ml-2 inline-block w-16 h-1.5 rounded-full align-middle"
                        style={{ background: 'rgba(0,0,0,0.3)' }}>
                        <span className="block h-full rounded-full" style={{ width: `${g.winPct}%`, background: style.text }} />
                      </span>
                    </div>
                  </div>

                  <ChevronDown size={16} className="text-slate-500 shrink-0 transition-transform"
                    style={{ transform: (expandedCard === g.userId) ? 'rotate(180deg)' : 'none' }} />
                </button>

                {expandedCard === g.userId && (
                  <div className="px-4 pb-4">
                    <div className="h-px mb-3" style={{ background: style.border + '60' }} />
                    <p className="text-sm text-slate-300 leading-relaxed">{g.summary}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
