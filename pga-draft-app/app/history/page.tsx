'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import { get, ref } from 'firebase/database';
import { db } from '@/lib/firebase';
import { Trophy, Lock, ChevronDown, ChevronRight, Users, Calendar, TrendingUp, RefreshCw, Radio, Star, Copy, Check, BarChart2 } from 'lucide-react';
import { parseLeaderboard } from '@/lib/espn';
import { calculateLeaderboard } from '@/lib/scoring';
import { getDraftState, getSeasonArchive, getTournamentsByYear, getAlltimeGolferStats, getAllTimeTeamData } from '@/lib/db';
import confetti from 'canvas-confetti';
import type { SeasonArchive, GolferAllTimeStats, AllTimeTeamData, ManagerAllTimeStats } from '@/lib/types';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamScore {
  userId: string; username: string; top3Score: number; rank: number;
  players?: { playerName: string; points: number; countsInTop3: boolean; positionDisplay: string }[];
}
interface LockedTournament {
  tournamentId: string; tournamentName: string; year: number;
  lockedAt: string; lockedBy: string; teamScores: TeamScore[];
}
interface HistoricalDraft {
  id: string; tournamentId: string; tournamentName: string; year: number;
  users: string[]; picksPerUser: number; hasScores: boolean;
  picksByUser: Record<string, { username: string; picks: { playerName: string }[] }>;
  playerScores?: Record<string, Record<string, number>>;
}
interface TournEntry { key: string; name: string; year: number; locked?: LockedTournament; historical?: HistoricalDraft; }
interface YearGroup  { year: number; tournaments: TournEntry[]; }

interface SeasonRow {
  username: string;
  scores: (number | null)[]; // one per SEASON_COLS entry
  total: number;
  rank: number;
}

// ─── Season column definition ─────────────────────────────────────────────────

interface SeasonColDef {
  id: string;
  label: string;
  live?: boolean;
  espnEventId?: string;
  cutLine?: number;
  liveScoresStart?: string;
}

const SEASON_SHORT_LABELS: Record<string, string> = {
  'players-championship': 'Players',
  'masters': 'Masters',
  'pga-championship': 'PGA',
  'us-open': 'US Open',
  'the-open': 'The Open',
};

const CURRENT_YEAR = new Date().getFullYear();

// ─── Colours ──────────────────────────────────────────────────────────────────

const SEASON_COLORS = ['#E8C94A','#3D80C0','#34d399','#f87171','#a78bfa','#fb923c','#38bdf8','#f472b6','#c084fc','#4ade80'];

// ─── Mini helper ─────────────────────────────────────────────────────────────

const TOURN_ORDER = ['players-championship','masters','pga-championship','us-open','the-open','tour-championship'];
const tSort = (id: string) => { const i = TOURN_ORDER.indexOf(id); return i >= 0 ? i : 99; };
const rankIcon = (r: number) => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `${r}.`;

const fmtScore = (s: number | null) => {
  if (s === null) return '—';
  if (s >= 9000) return 'DNS';
  return s > 0 ? `+${s}` : `${s}`;
};

// Pick-points display: unmatched / no-show golfers (>= 9000) render as a
// missed cut rather than the raw +9999 sentinel.
const fmtPts = (p: number) => p >= 9000 ? 'MC' : (p > 0 ? `+${p}` : `${p}`);

// ─── Season Trend Chart ───────────────────────────────────────────────────────

function SeasonChart({ rows, liveIdx, cols }: { rows: SeasonRow[]; liveIdx: number; cols: SeasonColDef[] }) {
  const W = 500, H = 180, PAD = { t: 12, r: 16, b: 48, l: 36 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  const n  = cols.length;
  if (n < 2) return null;

  // Build cumulative scores per row: cumRow[ci] = sum of scores[0..ci]
  const cumRows = rows.map(row => {
    let running = 0;
    return row.scores.map(s => {
      if (s === null || s >= 9000) return null;
      running += s;
      return running;
    });
  });

  const allCum = cumRows.flat().filter((s): s is number => s !== null);
  if (allCum.length === 0) return null;

  const minS = Math.min(...allCum);
  const maxS = Math.max(...allCum);
  const range = Math.max(maxS - minS, 10);
  const padded = range * 0.15;

  // Lower cumulative = better = top of chart
  const toY = (s: number) => {
    const t = (s - (minS - padded)) / (range + 2 * padded);
    return PAD.t + t * cH;
  };
  const toX = (col: number) => PAD.l + (col / (n - 1)) * cW;

  // Y-axis grid lines
  const yTicks = 4;
  const tickStep = range / yTicks;
  const gridTicks = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(minS + i * tickStep));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: 'visible' }}>
      {/* Grid lines */}
      {gridTicks.map((val, i) => (
        <g key={i}>
          <line
            x1={PAD.l} y1={toY(val)} x2={W - PAD.r} y2={toY(val)}
            stroke="rgba(255,255,255,0.06)" strokeWidth="1"
          />
          <text
            x={PAD.l - 6} y={toY(val) + 4}
            fill="rgba(148,163,184,0.4)" fontSize="9" textAnchor="end"
          >
            {val > 0 ? `+${val}` : val}
          </text>
        </g>
      ))}

      {/* Column (tournament) vertical guides */}
      {cols.map((col, ci) => (
        <line key={col.id}
          x1={toX(ci)} y1={PAD.t} x2={toX(ci)} y2={PAD.t + cH}
          stroke="rgba(255,255,255,0.04)" strokeWidth="1"
        />
      ))}

      {/* Lines + dots per user */}
      {rows.map((row, ri) => {
        const color = SEASON_COLORS[ri % SEASON_COLORS.length];
        const pts = cumRows[ri]
          .map((s, ci) => (s !== null ? { x: toX(ci), y: toY(s), ci } : null))
          .filter((p): p is { x: number; y: number; ci: number } => p !== null);

        if (pts.length === 0) return null;

        // Build path
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

        return (
          <g key={row.username}>
            <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
            {pts.map(p => (
              <circle key={p.ci}
                cx={p.x} cy={p.y} r={p.ci === liveIdx ? 5 : 4}
                fill={p.ci === liveIdx ? color : '#0A1628'}
                stroke={color} strokeWidth={p.ci === liveIdx ? 2.5 : 2}
              />
            ))}
          </g>
        );
      })}

      {/* X-axis tournament labels */}
      {cols.map((col, ci) => (
        <g key={col.id}>
          <text
            x={toX(ci)} y={PAD.t + cH + 16}
            fill={ci === liveIdx ? '#E8C94A' : 'rgba(148,163,184,0.5)'}
            fontSize="9" textAnchor="middle" fontWeight={ci === liveIdx ? 700 : 400}
          >
            {col.label}
          </text>
          {ci === liveIdx && (
            <text x={toX(ci)} y={PAD.t + cH + 27} fill="#E8C94A" fontSize="7.5" textAnchor="middle" fontWeight={700}>
              LIVE
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ─── Chart legend ─────────────────────────────────────────────────────────────

function ChartLegend({ rows, appUsername }: { rows: SeasonRow[]; appUsername: string }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
      {rows.map((row, ri) => (
        <div key={row.username} className="flex items-center gap-1.5">
          <div className="w-3 h-0.5 rounded-full" style={{ background: SEASON_COLORS[ri % SEASON_COLORS.length] }} />
          <span className="text-xs" style={{ color: row.username === appUsername ? '#E8C94A' : 'rgba(148,163,184,0.6)' }}>
            {row.username}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Finish-rank helper (mirrors the aggregation route) ──────────────────────
const MISSED_CUT_RANK = 60;
function finishRankOf(positionDisplay: string, points: number): number {
  if (points >= 9000) return MISSED_CUT_RANK;
  const n = parseInt((positionDisplay ?? '').replace(/[^0-9]/g, ''), 10);
  return !isNaN(n) && n > 0 ? n : MISSED_CUT_RANK;
}

// Derive per-golfer stats for a single season from the stored performance log.
function golfersForSeason(all: GolferAllTimeStats[], year: number): GolferAllTimeStats[] {
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const acc: Record<string, { g: GolferAllTimeStats; pickSum: number; ptsSum: number; slotSum: number; finSum: number; n: number }> = {};
  for (const golfer of all) {
    for (const p of golfer.performances ?? []) {
      if (p.year !== year) continue;
      const key = golfer.playerName;
      const a = (acc[key] ??= {
        g: { playerName: golfer.playerName, timesDrafted: 0, avgPickSpot: 0, totalPoints: 0, avgPoints: 0,
             bestFinish: '-', bestPositionNumeric: 9999, slotPerformance: 0, avgFinishRank: 0, lastUpdated: golfer.lastUpdated, performances: [] },
        pickSum: 0, ptsSum: 0, slotSum: 0, finSum: 0, n: 0,
      });
      a.n++;
      a.pickSum += p.pickNumber;
      a.ptsSum += p.points;
      a.g.totalPoints += p.points;
      const fin = finishRankOf(p.positionDisplay, p.points);
      a.slotSum += (p.pickNumber - fin);
      a.finSum += fin;
      const posNum = parseInt((p.positionDisplay ?? '').replace(/[^0-9]/g, ''), 10);
      if (!isNaN(posNum) && posNum > 0 && posNum < a.g.bestPositionNumeric) { a.g.bestPositionNumeric = posNum; a.g.bestFinish = p.positionDisplay; }
      a.g.performances.push(p);
    }
  }
  return Object.values(acc).map(a => ({
    ...a.g,
    timesDrafted: a.n,
    avgPickSpot: a.n ? round1(a.pickSum / a.n) : 0,
    avgPoints: a.n ? round1(a.ptsSum / a.n) : 0,
    slotPerformance: a.n ? round1(a.slotSum / a.n) : 0,
    avgFinishRank: a.n ? round1(a.finSum / a.n) : 0,
  }));
}

// Recompute per-manager draft quality for a season from the clean performance
// log (used to self-heal the season archive if it was built before the sentinel fix).
type ManagerQuality = {
  username: string;
  totalPicks: number;
  avgPointsPerPick: number;
  bestPick: { playerName: string; points: number; positionDisplay: string };
  worstPick: { playerName: string; points: number; positionDisplay: string };
  biggestSteal: { playerName: string; pickNumber: number; positionDisplay: string };
};
function managerQualityForSeason(all: GolferAllTimeStats[], year: number): ManagerQuality[] {
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const acc: Record<string, { m: ManagerQuality; ptsSum: number; bestSteal: number }> = {};
  for (const golfer of all) {
    for (const p of golfer.performances ?? []) {
      if (p.year !== year || !p.draftedBy) continue;
      const a = (acc[p.draftedBy] ??= {
        m: { username: p.draftedBy, totalPicks: 0, avgPointsPerPick: 0,
             bestPick: { playerName: '', points: Infinity, positionDisplay: '-' },
             worstPick: { playerName: '', points: -Infinity, positionDisplay: '-' },
             biggestSteal: { playerName: '', pickNumber: 0, positionDisplay: '-' } },
        ptsSum: 0, bestSteal: -Infinity,
      });
      a.m.totalPicks++;
      a.ptsSum += p.points;
      if (p.points < a.m.bestPick.points) a.m.bestPick = { playerName: golfer.playerName, points: p.points, positionDisplay: p.positionDisplay };
      if (p.points > a.m.worstPick.points) a.m.worstPick = { playerName: golfer.playerName, points: p.points, positionDisplay: p.positionDisplay };
      const val = -p.points + p.pickNumber / 2;
      if (val > a.bestSteal) { a.bestSteal = val; a.m.biggestSteal = { playerName: golfer.playerName, pickNumber: p.pickNumber, positionDisplay: p.positionDisplay }; }
    }
  }
  return Object.values(acc)
    .map(a => ({ ...a.m, avgPointsPerPick: a.m.totalPicks ? round1(a.ptsSum / a.m.totalPicks) : 0 }))
    .sort((x, y) => x.avgPointsPerPick - y.avgPointsPerPick);
}

// ─── Slot-performance badge ───────────────────────────────────────────────────
// slotPerformance = avg(pickSlot - finishRank). Positive = beats draft slot.

function slotLabel(v: number): { text: string; color: string; bg: string } {
  if (v >= 8)  return { text: 'Steal',        color: '#34d399', bg: 'rgba(52,211,153,0.15)' };
  if (v >= 2)  return { text: 'Overperforms', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' };
  if (v > -2)  return { text: 'On slot',       color: 'rgba(148,163,184,0.7)', bg: 'rgba(255,255,255,0.05)' };
  if (v > -8)  return { text: 'Underperforms', color: '#fb923c', bg: 'rgba(251,146,60,0.12)' };
  return { text: 'Reach',         color: '#f87171', bg: 'rgba(248,113,113,0.15)' };
}

function SlotBadge({ v }: { v: number }) {
  const s = slotLabel(v);
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold whitespace-nowrap"
      style={{ color: s.color, background: s.bg }}>
      {v > 0 ? '+' : ''}{v} · {s.text}
    </span>
  );
}

// ─── All-Time Team / Manager analysis ─────────────────────────────────────────

function TeamAnalysis({
  data, appUsername, view, setView,
}: {
  data: AllTimeTeamData;
  appUsername: string;
  view: 'standings' | 'records' | 'tendencies' | 'h2h';
  setView: (v: 'standings' | 'records' | 'tendencies' | 'h2h') => void;
}) {
  const managers = data.managers ?? [];
  const known = managers.some(m => m.username === appUsername) ? appUsername : (managers[0]?.username ?? '');
  const [sel, setSel] = useState<string>(known);
  const selMgr = managers.find(m => m.username === sel) ?? managers[0];

  const TABS: { id: typeof view; label: string }[] = [
    { id: 'standings',  label: '🏆 Standings' },
    { id: 'records',    label: '📊 Records' },
    { id: 'tendencies', label: '🎯 Draft Tendencies' },
    { id: 'h2h',        label: '⚔️ Head-to-Head' },
  ];

  // Distinct tournament ids across managers (for records table), ordered
  const tournIds: { id: string; name: string }[] = (() => {
    const map: Record<string, string> = {};
    for (const m of managers) for (const [id, r] of Object.entries(m.tournamentRecords ?? {})) map[id] = r.tournamentName;
    return Object.entries(map)
      .sort(([a], [b]) => tSort(a) - tSort(b))
      .map(([id, name]) => ({ id, name }));
  })();

  const ManagerChips = () => (
    <div className="flex flex-wrap gap-1.5 mb-4">
      {managers.map(m => (
        <button key={m.username} onClick={() => setSel(m.username)}
          className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
          style={sel === m.username
            ? { background: '#1B3A9E', color: '#fff' }
            : { background: 'rgba(255,255,255,0.05)', color: 'rgba(148,163,184,0.6)', border: '1px solid rgba(255,255,255,0.07)' }}>
          {m.username}{m.username === appUsername ? ' (you)' : ''}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Analysis sub-tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setView(t.id)}
            className="px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all"
            style={view === t.id
              ? { background: 'rgba(201,162,39,0.18)', color: '#E8C94A', border: '1px solid rgba(201,162,39,0.4)' }
              : { background: 'rgba(255,255,255,0.04)', color: 'rgba(148,163,184,0.55)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Standings ── */}
      {view === 'standings' && (
        <div className="card" style={{ padding: 0 }}>
          <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <h3 className="font-bebas text-xl tracking-wider text-white">Career Standings</h3>
            <p className="text-xs mt-0.5" style={{ color: 'rgba(148,163,184,0.4)' }}>Titles, career points & finishes across all seasons</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['#', 'Manager', 'Titles', 'Seasons', 'Career Pts', 'Avg Finish', 'Best', 'Worst'].map(h => (
                    <th key={h} className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(148,163,184,0.4)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {managers.map((m, i) => {
                  const isMe = m.username === appUsername;
                  return (
                    <tr key={m.username} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', background: isMe ? 'rgba(0,107,182,0.08)' : 'transparent' }}>
                      <td className="px-3 py-2.5 text-xs font-mono" style={{ color: 'rgba(148,163,184,0.3)' }}>{i + 1}.</td>
                      <td className="px-3 py-2.5 font-semibold text-white whitespace-nowrap">{m.username}{isMe && <span className="ml-1 text-xs" style={{ color: 'rgba(0,107,182,0.7)' }}>you</span>}</td>
                      <td className="px-3 py-2.5">
                        <span className="font-mono font-bold" style={{ color: m.titles > 0 ? '#E8C94A' : 'rgba(148,163,184,0.4)' }}>
                          {m.titles > 0 ? '🏆'.repeat(Math.min(m.titles, 3)) : ''}{m.titles > 3 ? `×${m.titles}` : ''} {m.titles === 0 ? '—' : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono text-xs" style={{ color: 'rgba(148,163,184,0.5)' }}>{m.seasonsPlayed}</td>
                      <td className="px-3 py-2.5 font-mono text-sm" style={{ color: m.careerPoints < 0 ? '#34d399' : '#94a3b8' }}>{m.careerPoints > 0 ? '+' : ''}{m.careerPoints}</td>
                      <td className="px-3 py-2.5 text-center font-mono text-xs" style={{ color: 'rgba(148,163,184,0.6)' }}>{m.avgSeasonFinish}</td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#34d399' }}>{m.bestSeason ? `${rankIcon(m.bestSeason.rank)} ${m.bestSeason.year}` : '—'}</td>
                      <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: 'rgba(248,113,113,0.7)' }}>{m.worstSeason ? `${m.worstSeason.rank}. ${m.worstSeason.year}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Tournament Records ── */}
      {view === 'records' && selMgr && (
        <div className="card" style={{ padding: 0 }}>
          <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <h3 className="font-bebas text-xl tracking-wider text-white">Tournament Records</h3>
            <p className="text-xs mt-0.5" style={{ color: 'rgba(148,163,184,0.4)' }}>Each manager&apos;s record at every major · lower score = better</p>
          </div>
          <div className="px-4 pt-4"><ManagerChips /></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Major', 'Played', 'Wins', 'Best', 'Worst', 'Avg'].map(h => (
                    <th key={h} className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(148,163,184,0.4)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tournIds.map(({ id, name }) => {
                  const r = selMgr.tournamentRecords?.[id];
                  return (
                    <tr key={id} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td className="px-3 py-2.5 text-white text-sm whitespace-nowrap">{SEASON_SHORT_LABELS[id] ?? name}</td>
                      {r ? (
                        <>
                          <td className="px-3 py-2.5 text-center font-mono text-xs" style={{ color: 'rgba(148,163,184,0.5)' }}>{r.count}</td>
                          <td className="px-3 py-2.5 text-center font-mono text-xs" style={{ color: r.wins > 0 ? '#E8C94A' : 'rgba(148,163,184,0.4)' }}>{r.wins > 0 ? `${r.wins}🏆` : '—'}</td>
                          <td className="px-3 py-2.5 font-mono text-sm font-bold" style={{ color: '#34d399' }}>{fmtScore(r.best)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs" style={{ color: 'rgba(248,113,113,0.7)' }}>{fmtScore(r.worst)}</td>
                          <td className="px-3 py-2.5 font-mono text-xs" style={{ color: 'rgba(148,163,184,0.6)' }}>{r.avg}</td>
                        </>
                      ) : (
                        <td colSpan={5} className="px-3 py-2.5 text-xs italic" style={{ color: 'rgba(148,163,184,0.3)' }}>Never played</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Draft Tendencies ── */}
      {view === 'tendencies' && selMgr && (
        <div className="space-y-4">
          <div className="card">
            <ManagerChips />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
                <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'rgba(148,163,184,0.4)' }}>Draft Skill</p>
                <SlotBadge v={selMgr.slotSkill} />
                <p className="text-xs mt-1.5" style={{ color: 'rgba(148,163,184,0.35)' }}>{selMgr.totalPicks} career picks · value vs draft slot</p>
              </div>
              <div className="rounded-xl p-3" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)' }}>
                <p className="text-xs uppercase tracking-widest mb-1" style={{ color: '#34d399' }}>Best Steal</p>
                {selMgr.bestSteal ? (
                  <>
                    <p className="text-white text-sm font-semibold truncate">{selMgr.bestSteal.playerName}</p>
                    <p className="text-xs" style={{ color: 'rgba(148,163,184,0.5)' }}>Pick #{selMgr.bestSteal.pickNumber} → {selMgr.bestSteal.positionDisplay} · {selMgr.bestSteal.tournamentName} {selMgr.bestSteal.year}</p>
                  </>
                ) : <p className="text-xs italic" style={{ color: 'rgba(148,163,184,0.3)' }}>—</p>}
              </div>
              <div className="rounded-xl p-3" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
                <p className="text-xs uppercase tracking-widest mb-1" style={{ color: '#f87171' }}>Worst Bust</p>
                {selMgr.worstBust ? (
                  <>
                    <p className="text-white text-sm font-semibold truncate">{selMgr.worstBust.playerName}</p>
                    <p className="text-xs" style={{ color: 'rgba(148,163,184,0.5)' }}>Pick #{selMgr.worstBust.pickNumber} → {selMgr.worstBust.positionDisplay} · {selMgr.worstBust.tournamentName} {selMgr.worstBust.year}</p>
                  </>
                ) : <p className="text-xs italic" style={{ color: 'rgba(148,163,184,0.3)' }}>—</p>}
              </div>
            </div>
          </div>
          <div className="card">
            <h4 className="font-bebas text-lg tracking-wider text-white mb-3">Most Drafted by {selMgr.username}</h4>
            {selMgr.mostDrafted?.length ? (
              <div className="space-y-1.5">
                {selMgr.mostDrafted.map((d, i) => (
                  <div key={d.playerName} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm" style={{ background: 'rgba(255,255,255,0.04)' }}>
                    <span className="w-5 text-center text-xs" style={{ color: 'rgba(148,163,184,0.4)' }}>{i + 1}.</span>
                    <span className="flex-1 text-white font-semibold">{d.playerName}</span>
                    <span className="font-mono text-xs" style={{ color: '#E8C94A' }}>{d.count}×</span>
                  </div>
                ))}
              </div>
            ) : <p className="text-xs italic" style={{ color: 'rgba(148,163,184,0.3)' }}>No picks recorded.</p>}
          </div>
        </div>
      )}

      {/* ── Head-to-Head ── */}
      {view === 'h2h' && selMgr && (
        <div className="card" style={{ padding: 0 }}>
          <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <h3 className="font-bebas text-xl tracking-wider text-white">Head-to-Head</h3>
            <p className="text-xs mt-0.5" style={{ color: 'rgba(148,163,184,0.4)' }}>Seasons finishing above each rival</p>
          </div>
          <div className="px-4 pt-4"><ManagerChips /></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[420px]">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Rival', 'Record (W–L)', 'Seasons', ''].map(h => (
                    <th key={h} className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(148,163,184,0.4)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {managers.filter(o => o.username !== selMgr.username).map(o => {
                  const [a, b] = [selMgr.username, o.username].sort();
                  const rec = data.headToHead?.[`${a}|${b}`];
                  const myWins = !rec ? 0 : (selMgr.username === a ? rec.aWins : rec.bWins);
                  const theirWins = !rec ? 0 : (selMgr.username === a ? rec.bWins : rec.aWins);
                  const seasons = rec?.seasons ?? 0;
                  const winning = myWins > theirWins, losing = theirWins > myWins;
                  return (
                    <tr key={o.username} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td className="px-3 py-2.5 text-white text-sm whitespace-nowrap">{o.username}</td>
                      <td className="px-3 py-2.5 font-mono text-sm font-bold" style={{ color: winning ? '#34d399' : losing ? '#f87171' : 'rgba(148,163,184,0.6)' }}>{myWins}–{theirWins}</td>
                      <td className="px-3 py-2.5 font-mono text-xs" style={{ color: 'rgba(148,163,184,0.4)' }}>{seasons}</td>
                      <td className="px-3 py-2.5 text-xs" style={{ color: winning ? '#34d399' : losing ? '#f87171' : 'rgba(148,163,184,0.4)' }}>{seasons === 0 ? '' : winning ? 'leads' : losing ? 'trails' : 'even'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const { appUser, loading } = useAuth();
  const router = useRouter();
  const [yearGroups, setYearGroups] = useState<YearGroup[]>([]);
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const [expandedTourn, setExpandedTourn] = useState<string | null>(null);
  const [expandedPicks, setExpandedPicks] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);
  const [stats, setStats] = useState<{ username: string; wins: number; podiums: number; total: number; count: number }[]>([]);

  // Dynamic season column definitions (loaded from Firebase)
  const [seasonCols, setSeasonCols] = useState<SeasonColDef[]>([]);
  const seasonColsRef = useRef<SeasonColDef[]>([]);

  // Season-standings state
  const [season2026, setSeason2026] = useState<SeasonRow[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const liveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Season archive (analytics + AI recap)
  const [archive, setArchive] = useState<SeasonArchive | null>(null);
  const [recapCopied, setRecapCopied] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [seasonGolferShowAll, setSeasonGolferShowAll] = useState(false);
  const confettiFiredRef = useRef(false);

  // All-time golfer stats
  const [allTimeGolferStats, setAllTimeGolferStats] = useState<GolferAllTimeStats[]>([]);
  const [allTimeView, setAllTimeView] = useState<'managers' | 'golfers'>('managers');
  const [golferShowAll, setGolferShowAll] = useState(false);
  const [golferSort, setGolferSort] = useState<'total' | 'drafted' | 'avg' | 'pick' | 'slot'>('total');
  const [golferSeason, setGolferSeason] = useState<'all' | number>('all');

  // All-time team/manager data (titles, records, tendencies, head-to-head)
  const [teamData, setTeamData] = useState<AllTimeTeamData | null>(null);
  const [teamAnalysis, setTeamAnalysis] = useState<'standings' | 'records' | 'tendencies' | 'h2h'>('standings');

  // Tab navigation
  const [activeTab, setActiveTab] = useState<'season' | 'alltime'>('season');

  useEffect(() => { if (!loading && !appUser) router.push('/'); }, [loading, appUser, router]);

  // ── Load locked scores + historical picks ─────────────────────────────────
  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [lockedSnap, histSnap, archiveData, yearTournaments, golferStats, allTeamData] = await Promise.all([
        get(ref(db, 'lockedScores')),
        get(ref(db, 'historicalDrafts')),
        getSeasonArchive(CURRENT_YEAR).catch(() => null),
        getTournamentsByYear(CURRENT_YEAR),
        getAlltimeGolferStats().catch(() => []),
        getAllTimeTeamData().catch(() => null),
      ]);
      if (archiveData) setArchive(archiveData);
      setAllTimeGolferStats(golferStats);
      setTeamData(allTeamData);
      const locked: Record<string, LockedTournament> = lockedSnap.exists() ? lockedSnap.val() : {};
      const historical: Record<string, HistoricalDraft> = histSnap.exists() ? histSnap.val() : {};

      const map: Record<string, TournEntry> = {};
      for (const lt of Object.values(locked)) {
        const y = lt.year ?? new Date(lt.lockedAt).getFullYear();
        const k = `${y}-${lt.tournamentId}`;
        map[k] = { key: k, name: lt.tournamentName, year: y, locked: lt };
      }
      for (const hd of Object.values(historical)) {
        const k = `${hd.year}-${hd.tournamentId}`;
        if (!map[k]) map[k] = { key: k, name: hd.tournamentName, year: hd.year };
        map[k].historical = hd;
      }

      const byYear: Record<number, TournEntry[]> = {};
      for (const e of Object.values(map)) {
        (byYear[e.year] ??= []).push(e);
      }
      for (const list of Object.values(byYear)) {
        list.sort((a, b) => tSort(a.locked?.tournamentId ?? a.historical?.tournamentId ?? '')
                          - tSort(b.locked?.tournamentId ?? b.historical?.tournamentId ?? ''));
      }
      const groups: YearGroup[] = Object.entries(byYear)
        .sort(([a],[b]) => +b - +a)
        .map(([y, t]) => ({ year: +y, tournaments: t }));

      setYearGroups(groups);
      if (groups.length) setExpandedYear(groups[0].year);

      // All-time stats from locked scores
      const st: Record<string, { wins: number; podiums: number; total: number; count: number }> = {};
      for (const lt of Object.values(locked)) {
        for (const ts of lt.teamScores ?? []) {
          st[ts.username] ??= { wins:0, podiums:0, total:0, count:0 };
          st[ts.username].total += ts.top3Score;
          st[ts.username].count++;
          if (ts.rank === 1) st[ts.username].wins++;
          if (ts.rank <= 3) st[ts.username].podiums++;
        }
      }
      setStats(Object.entries(st).map(([username, s]) => ({ username, ...s })).sort((a,b) => a.total - b.total));

      // ── Build season column definitions from Firebase tournaments ──────────
      const sorted = yearTournaments.sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99));

      // Determine which tournament is "live": active one, else last non-upcoming
      let liveTournId: string | null = null;
      const active = sorted.filter(t => t.status === 'active');
      if (active.length > 0) {
        liveTournId = active[0].id;
      } else {
        const nonUpcoming = sorted.filter(t => t.status !== 'upcoming');
        liveTournId = nonUpcoming.length > 0
          ? nonUpcoming[nonUpcoming.length - 1].id
          : sorted.length > 0 ? sorted[sorted.length - 1].id : null;
      }

      const cols: SeasonColDef[] = sorted.map(t => ({
        id: t.id,
        label: SEASON_SHORT_LABELS[t.id] ?? t.shortName ?? t.name,
        live: t.id === liveTournId,
        espnEventId: t.espnEventId,
        cutLine: t.cutLine,
        liveScoresStart: t.liveScoresStart,
      }));

      setSeasonCols(cols);
      seasonColsRef.current = cols;

      // ── Build current season from locked data ──────────────────────────────
      const seasonIds = new Set(cols.map(c => c.id));
      const lockedByTournId: Record<string, LockedTournament> = {};
      for (const lt of Object.values(locked)) {
        if (!seasonIds.has(lt.tournamentId)) continue;
        const existing = lockedByTournId[lt.tournamentId];
        if (!existing || new Date(lt.lockedAt).getTime() > new Date(existing.lockedAt).getTime()) {
          lockedByTournId[lt.tournamentId] = lt;
        }
      }

      const allUsernames = new Set<string>();
      for (const lt of Object.values(lockedByTournId)) {
        for (const ts of lt.teamScores ?? []) allUsernames.add(ts.username);
      }

      const rowMap: Record<string, { username: string; scores: (number | null)[] }> = {};
      for (const username of allUsernames) {
        rowMap[username] = { username, scores: cols.map(() => null) };
        cols.forEach((col, ci) => {
          if (col.live) return; // filled by live fetch below
          const lt = lockedByTournId[col.id];
          if (!lt) return;
          const ts = lt.teamScores?.find(t => t.username === username);
          if (ts) rowMap[username].scores[ci] = ts.top3Score;
        });
      }

      setSeason2026(buildRankedRows(rowMap));
      setFetching(false);

      fetchLiveOpen(rowMap, cols);
    }
    load().catch(() => setFetching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUser]);

  // ── Live refresh interval ─────────────────────────────────────────────────
  useEffect(() => {
    liveTimer.current = setInterval(() => {
      setSeason2026(prev => {
        const rowMap: Record<string, { username: string; scores: (number | null)[] }> = {};
        for (const row of prev) {
          rowMap[row.username] = { username: row.username, scores: [...row.scores] };
        }
        fetchLiveOpen(rowMap, seasonColsRef.current);
        return prev;
      });
    }, 60_000);
    return () => { if (liveTimer.current) clearInterval(liveTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch live scores for the active/latest tournament ───────────────────
  async function fetchLiveOpen(
    rowMap: Record<string, { username: string; scores: (number | null)[] }>,
    cols: SeasonColDef[],
  ) {
    const liveColIdx = cols.findIndex(c => c.live);
    if (liveColIdx < 0 || cols.length === 0) return;
    const liveCol = cols[liveColIdx];
    if (!liveCol.espnEventId) return;

    const now = Date.now();
    const liveStart = liveCol.liveScoresStart ? new Date(liveCol.liveScoresStart).getTime() : 0;
    if (liveStart > 0 && now < liveStart) {
      setSeason2026(buildRankedRows(rowMap));
      return;
    }

    setLiveLoading(true);
    try {
      const [espnRes, draftState] = await Promise.all([
        fetch(`/api/espn/leaderboard?eventId=${liveCol.espnEventId}`),
        getDraftState(liveCol.id),
      ]);
      if (!espnRes.ok || !draftState) return;

      const espnData = await espnRes.json();
      const { players } = parseLeaderboard(espnData);

      const userPicksMap: Record<string, { username: string; picks: import('@/lib/types').DraftPick[] }> = {};
      for (const pick of draftState.picks) {
        userPicksMap[pick.userId] ??= { username: pick.username, picks: [] };
        userPicksMap[pick.userId].picks.push(pick);
        if (!rowMap[pick.username]) {
          rowMap[pick.username] = { username: pick.username, scores: cols.map(() => null) };
        }
      }

      const liveTeams = calculateLeaderboard(userPicksMap, players, liveCol.cutLine ?? 65);

      const merged: Record<string, { username: string; scores: (number | null)[] }> = {};
      for (const [u, v] of Object.entries(rowMap)) merged[u] = { username: v.username, scores: [...v.scores] };
      for (const team of liveTeams) {
        if (!merged[team.username]) {
          merged[team.username] = { username: team.username, scores: cols.map(() => null) };
        }
        merged[team.username].scores[liveColIdx] = team.top3Score >= 9000 ? null : team.top3Score;
      }

      setSeason2026(buildRankedRows(merged));
      setLastUpdated(new Date());
    } catch { /* silently ignore */ }
    finally { setLiveLoading(false); }
  }

  function buildRankedRows(rowMap: Record<string, { username: string; scores: (number | null)[] }>): SeasonRow[] {
    const rows = Object.values(rowMap).map(({ username, scores }) => {
      const total = scores.reduce<number>((sum, s) => sum + (s !== null && s < 9000 ? s : 0), 0);
      return { username, scores, total, rank: 0 };
    });
    rows.sort((a, b) => a.total - b.total);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  // Fire confetti once per session when season archive loads
  useEffect(() => {
    if (!archive || confettiFiredRef.current) return;
    const confettiKey = `warrior-cup-confetti-${archive.year}`;
    if (sessionStorage.getItem(confettiKey)) return;
    confettiFiredRef.current = true;
    sessionStorage.setItem(confettiKey, '1');
    // Gold + white burst
    confetti({ particleCount: 150, spread: 100, origin: { y: 0.35 }, colors: ['#E8C94A','#C9A227','#fff','#fbbf24','#f59e0b'] });
    setTimeout(() => confetti({ particleCount: 80, spread: 80, origin: { y: 0.4, x: 0.2 }, colors: ['#E8C94A','#C9A227','#fff'] }), 350);
    setTimeout(() => confetti({ particleCount: 80, spread: 80, origin: { y: 0.4, x: 0.8 }, colors: ['#E8C94A','#C9A227','#fff'] }), 500);
  }, [archive]);

  const liveColIdx = seasonCols.findIndex(c => c.live);
  const hasLiveScores = liveColIdx >= 0 && season2026.some(r => r.scores[liveColIdx] !== null);

  if (loading || !appUser) return (
    <div className="min-h-screen page"><Navigation />
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-4">
        <div className="skeleton h-8 w-40 rounded-xl mb-6" />
        {[1,2,3].map(i => <div key={i} className="skeleton h-24 rounded-xl" />)}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen page">
      <Navigation />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[900px] h-64 pointer-events-none"
        style={{background:'radial-gradient(ellipse, rgba(0,107,182,0.1) 0%, transparent 70%)'}} />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-8 space-y-6">

        {/* ── Tab navigation ── */}
        <div className="flex gap-2">
          {([
            { key: 'season',  label: `${CURRENT_YEAR} Season`,  icon: '🏆' },
            { key: 'alltime', label: 'All-Time',      icon: '📜' },
          ] as const).map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className="px-5 py-2 rounded-xl text-sm font-bold tracking-wide transition-all"
              style={activeTab === key
                ? { background: '#1B3A9E', color: '#fff', border: '1px solid rgba(27,58,158,0.6)' }
                : { background: 'rgba(255,255,255,0.05)', color: 'rgba(148,163,184,0.7)', border: '1px solid rgba(255,255,255,0.07)' }
              }>
              {icon} {label}
            </button>
          ))}
        </div>

        {/* ── 2026 Season Standings ── */}
        {activeTab === 'season' && <section>

          {/* Champion Banner — shown once admin runs End Season */}
          {archive && (
            <div className="mb-6 rounded-2xl px-6 py-5 relative overflow-hidden"
              style={{background:'linear-gradient(135deg, rgba(201,162,39,0.22) 0%, rgba(232,201,74,0.12) 50%, rgba(201,162,39,0.08) 100%)', border:'1px solid rgba(201,162,39,0.4)'}}>
              {/* Subtle shimmer stripe */}
              <div className="absolute inset-0 pointer-events-none" style={{background:'linear-gradient(105deg, transparent 40%, rgba(232,201,74,0.07) 50%, transparent 60%)'}} />
              <div className="relative flex items-center gap-4">
                <div className="text-5xl select-none" style={{filter:'drop-shadow(0 0 16px rgba(232,201,74,0.6))'}}>🏆</div>
                <div>
                  <p className="text-xs uppercase tracking-widest font-semibold" style={{color:'rgba(201,162,39,0.7)'}}>{archive.year} Warrior Cup Champion</p>
                  <h2 className="font-bebas text-4xl tracking-widest mt-0.5" style={{color:'#E8C94A',textShadow:'0 0 20px rgba(232,201,74,0.4)'}}>{archive.champion.username}</h2>
                  <p className="text-sm mt-1" style={{color:'rgba(201,162,39,0.6)'}}>
                    {archive.champion.totalPoints > 0 ? '+' : ''}{archive.champion.totalPoints} pts season total
                  </p>
                </div>
                <div className="ml-auto hidden sm:flex flex-col items-end gap-1">
                  {archive.seasonStandings.slice(1, 3).map((s, i) => (
                    <div key={s.userId} className="flex items-center gap-2 text-sm">
                      <span style={{color:'rgba(148,163,184,0.4)'}}>{i === 0 ? '🥈' : '🥉'}</span>
                      <span style={{color:'rgba(148,163,184,0.5)'}}>{s.username}</span>
                      <span className="font-mono" style={{color:'rgba(148,163,184,0.35)'}}>{s.total > 0 ? '+' : ''}{s.total}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs uppercase tracking-widest font-semibold mb-0.5" style={{color:'rgba(148,163,184,0.5)'}}>Current Year</p>
              <h2 className="font-bebas text-3xl tracking-widest text-white flex items-center gap-2">
                <TrendingUp size={24} style={{color:'#E8C94A'}} /> {CURRENT_YEAR} Season Standings
              </h2>
            </div>
            <div className="flex items-center gap-3">
              {hasLiveScores && (
                <div className="flex items-center gap-1.5">
                  <Radio size={11} className="animate-pulse" style={{color:'#f87171'}} />
                  <span className="text-xs font-semibold" style={{color:'#f87171'}}>LIVE</span>
                </div>
              )}
              <button
                onClick={() => {
                  const rowMap: Record<string, { username: string; scores: (number | null)[] }> = {};
                  for (const row of season2026) rowMap[row.username] = { username: row.username, scores: [...row.scores] };
                  fetchLiveOpen(rowMap, seasonCols);
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all"
                style={{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.08)',color:'rgba(148,163,184,0.6)'}}
                disabled={liveLoading}
              >
                <RefreshCw size={11} className={liveLoading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>
          </div>

          {fetching ? (
            <div className="space-y-2">{[1,2,3,4].map(i => <div key={i} className="skeleton h-10 rounded-xl" />)}</div>
          ) : season2026.length === 0 ? (
            <div className="card text-center py-8 text-sm" style={{color:'rgba(148,163,184,0.4)'}}>
              Season data will appear once the first tournament is scored.
            </div>
          ) : (
            <div className="space-y-4">
              {/* Standings table */}
              <div className="card overflow-x-auto" style={{padding:0}}>
                <table className="w-full text-sm min-w-[420px]">
                  <thead>
                    <tr style={{borderBottom:'1px solid rgba(255,255,255,0.07)'}}>
                      <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)',width:'28px'}}>#</th>
                      <th className="text-left px-2 py-2.5 font-semibold text-xs uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)'}}>Player</th>
                      {seasonCols.map((col, ci) => (
                        <th key={col.id} className="text-center px-2 py-2.5 font-semibold text-xs uppercase tracking-wider whitespace-nowrap" style={{
                          color: ci === liveColIdx ? '#E8C94A' : 'rgba(148,163,184,0.4)',
                          minWidth: '52px',
                        }}>
                          {col.label}{ci === liveColIdx && hasLiveScores ? ' 🔴' : ''}
                        </th>
                      ))}
                      <th className="text-center px-3 py-2.5 font-bold text-xs uppercase tracking-wider" style={{color:'rgba(148,163,184,0.6)',minWidth:'52px'}}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {season2026.map((row) => {
                      const isMe = row.username === appUser.username;
                      return (
                        <tr key={row.username}
                          style={{
                            borderBottom: '1px solid rgba(255,255,255,0.04)',
                            background: isMe ? 'rgba(0,107,182,0.1)' : 'transparent',
                          }}>
                          <td className="px-4 py-2.5 text-center">
                            <span className="text-xs font-mono" style={{color:'rgba(148,163,184,0.4)'}}>{rankIcon(row.rank)}</span>
                          </td>
                          <td className="px-2 py-2.5">
                            <span className="font-semibold text-white">{row.username}</span>
                            {isMe && <span className="ml-1.5 text-xs" style={{color:'rgba(0,107,182,0.8)'}}>you</span>}
                          </td>
                          {row.scores.map((s, ci) => {
                            const isLive = ci === liveColIdx;
                            const val = fmtScore(s);
                            const color = s === null ? 'rgba(148,163,184,0.2)'
                              : s < 0 ? '#34d399'
                              : s <= 30 ? '#facc15'
                              : '#94a3b8';
                            return (
                              <td key={ci} className="text-center px-2 py-2.5">
                                <span className="font-mono text-xs font-bold"
                                  style={{color: isLive && s !== null ? '#E8C94A' : color}}>
                                  {val}
                                </span>
                              </td>
                            );
                          })}
                          <td className="text-center px-3 py-2.5">
                            <span className="font-mono font-bold text-sm" style={{color: row.total < 0 ? '#34d399' : '#e2e8f0'}}>
                              {fmtScore(row.total)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {lastUpdated && (
                  <div className="px-4 py-2 text-xs border-t" style={{color:'rgba(148,163,184,0.25)',borderColor:'rgba(255,255,255,0.05)'}}>
                    Live scores updated {lastUpdated.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}
                  </div>
                )}
              </div>

              {/* Trend chart */}
              <div className="card">
                <h3 className="font-bebas text-lg tracking-wider text-white mb-3 flex items-center gap-2">
                  <TrendingUp size={15} style={{color:'#E8C94A'}} /> Cumulative Season Score
                  <span className="text-xs font-sans font-normal ml-1" style={{color:'rgba(148,163,184,0.4)'}}>lower = better</span>
                </h3>
                <SeasonChart rows={season2026} liveIdx={liveColIdx} cols={seasonCols} />
                <ChartLegend rows={season2026} appUsername={appUser.username} />
              </div>

              {/* ── Season Analytics (only after End Season is run) ── */}
              {archive && (
                <div className="space-y-4">

                  {/* Collapsible analytics header */}
                  <button
                    onClick={() => setAnalyticsOpen(o => !o)}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all"
                    style={{background:'rgba(255,255,255,0.04)',border:'1px solid rgba(255,255,255,0.07)'}}>
                    <span className="font-bebas text-xl tracking-widest text-white flex items-center gap-2">
                      <BarChart2 size={18} style={{color:'#E8C94A'}} /> Season Analytics
                    </span>
                    {analyticsOpen
                      ? <ChevronDown size={15} style={{color:'rgba(148,163,184,0.4)'}} />
                      : <ChevronRight size={15} style={{color:'rgba(148,163,184,0.4)'}} />}
                  </button>

                  {analyticsOpen && (
                    <div className="space-y-4">

                      {/* Draft Quality Leaderboard */}
                      <div className="card" style={{padding:0}}>
                        <div className="px-4 pt-4 pb-3" style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                          <h3 className="font-bebas text-lg tracking-wider text-white flex items-center gap-2">
                            <Star size={14} style={{color:'#E8C94A'}} /> Draft Quality by Manager
                          </h3>
                          <p className="text-xs mt-0.5" style={{color:'rgba(148,163,184,0.4)'}}>Avg pts/pick lower = better · Steal = best score relative to pick position</p>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm min-w-[560px]">
                            <thead>
                              <tr style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                                {['Manager','Picks','Avg Pts/Pick','Best Pick','Worst Pick','Biggest Steal'].map(h => (
                                  <th key={h} className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)'}}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {(() => {
                                const recomputed = managerQualityForSeason(allTimeGolferStats, archive.year);
                                const rows: ManagerQuality[] = recomputed.length ? recomputed : archive.userDraftStats.map(u => ({
                                  username: u.username, totalPicks: u.totalPicks, avgPointsPerPick: u.avgPointsPerPick,
                                  bestPick: { playerName: u.bestPick.playerName, points: u.bestPick.points, positionDisplay: u.bestPick.positionDisplay },
                                  worstPick: { playerName: u.worstPick.playerName, points: u.worstPick.points, positionDisplay: u.worstPick.positionDisplay },
                                  biggestSteal: { playerName: u.biggestSteal.playerName, pickNumber: u.biggestSteal.pickNumber, positionDisplay: u.biggestSteal.positionDisplay },
                                }));
                                return rows.map((u) => {
                                const isMe = u.username === appUser.username;
                                return (
                                  <tr key={u.username} style={{borderBottom:'1px solid rgba(255,255,255,0.04)',background:isMe?'rgba(0,107,182,0.08)':'transparent'}}>
                                    <td className="px-3 py-2.5 font-semibold text-white">{u.username}{isMe && <span className="ml-1 text-xs" style={{color:'rgba(0,107,182,0.7)'}}>you</span>}</td>
                                    <td className="px-3 py-2.5 text-center font-mono text-xs" style={{color:'rgba(148,163,184,0.5)'}}>{u.totalPicks}</td>
                                    <td className="px-3 py-2.5 text-center">
                                      <span className="font-mono text-sm font-bold" style={{color:u.avgPointsPerPick<0?'#34d399':u.avgPointsPerPick<20?'#facc15':'#94a3b8'}}>
                                        {u.avgPointsPerPick>0?'+':''}{u.avgPointsPerPick}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2.5">
                                      <div className="text-xs text-white truncate max-w-[120px]">{u.bestPick.playerName}</div>
                                      <div className="text-xs font-mono" style={{color:'#34d399'}}>{fmtPts(u.bestPick.points)} ({u.bestPick.positionDisplay})</div>
                                    </td>
                                    <td className="px-3 py-2.5">
                                      <div className="text-xs text-white truncate max-w-[120px]">{u.worstPick.playerName}</div>
                                      <div className="text-xs font-mono" style={{color:'#f87171'}}>{fmtPts(u.worstPick.points)}</div>
                                    </td>
                                    <td className="px-3 py-2.5">
                                      <div className="text-xs text-white truncate max-w-[120px]">{u.biggestSteal.playerName}</div>
                                      <div className="text-xs font-mono" style={{color:'#E8C94A'}}>Pick #{u.biggestSteal.pickNumber} → {u.biggestSteal.positionDisplay}</div>
                                    </td>
                                  </tr>
                                );
                              });
                              })()}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Top Golfer Performances */}
                      {(() => {
                        const recomputed = golfersForSeason(allTimeGolferStats, archive.year);
                        const gsAll = (recomputed.length ? recomputed : archive.golferStats)
                          .slice().sort((a, b) => a.avgPoints - b.avgPoints);
                        const gs = seasonGolferShowAll ? gsAll : gsAll.slice(0, 20);
                        return (
                      <div className="card" style={{padding:0}}>
                        <div className="px-4 pt-4 pb-3" style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                          <h3 className="font-bebas text-lg tracking-wider text-white flex items-center gap-2">
                            <Trophy size={14} style={{color:'#C9A227'}} /> Golfer Season Stats
                          </h3>
                          <p className="text-xs mt-0.5" style={{color:'rgba(148,163,184,0.4)'}}>{gsAll.length} golfers drafted across {archive.year} · sorted by avg pts (lower = better)</p>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm min-w-[480px]">
                            <thead>
                              <tr style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                                {['Golfer','Times Drafted','Avg Pick','Best Finish','Total Pts','Avg Pts'].map(h => (
                                  <th key={h} className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)'}}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {gs.map((g, i) => (
                                <tr key={g.playerName} style={{borderBottom:'1px solid rgba(255,255,255,0.03)'}}>
                                  <td className="px-3 py-2.5">
                                    <span className="text-xs font-mono mr-1.5" style={{color:'rgba(148,163,184,0.3)'}}>{i+1}.</span>
                                    <span className="text-white text-sm">{g.playerName}</span>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className="text-xs font-mono" style={{color:g.timesDrafted>=3?'#E8C94A':'rgba(148,163,184,0.5)'}}>{g.timesDrafted}×</span>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className="text-xs font-mono" style={{color:'rgba(148,163,184,0.5)'}}>{g.avgPickSpot}</span>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className="text-xs font-mono font-bold" style={{color:g.bestPositionNumeric<=10?'#34d399':g.bestPositionNumeric<=30?'#facc15':'#94a3b8'}}>{g.bestFinish}</span>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className="font-mono font-bold text-sm" style={{color:g.totalPoints<0?'#34d399':g.totalPoints<40?'#facc15':'#94a3b8'}}>
                                      {fmtScore(g.totalPoints)}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2.5 text-center">
                                    <span className="font-mono text-xs" style={{color:g.avgPoints<0?'#34d399':'rgba(148,163,184,0.5)'}}>
                                      {g.avgPoints>0?'+':''}{g.avgPoints}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {gsAll.length > 20 && (
                          <button onClick={() => setSeasonGolferShowAll(v => !v)}
                            className="w-full py-3 text-xs transition-colors hover:text-white"
                            style={{color:'rgba(148,163,184,0.35)',borderTop:'1px solid rgba(255,255,255,0.05)'}}>
                            {seasonGolferShowAll ? 'Show top 20' : `Show all ${gsAll.length} golfers`}
                          </button>
                        )}
                      </div>
                        );
                      })()}
                    </div>
                  )}

                </div>
              )}

              {/* AI Season Recap — shown directly on the season tab, not buried in analytics */}
              {archive?.recap && (
                <div className="card" style={{background:'rgba(139,92,246,0.06)',border:'1px solid rgba(139,92,246,0.2)'}}>
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="font-bebas text-lg tracking-wider text-white flex items-center gap-2">
                      ✨ AI Season Recap
                    </h3>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(archive!.recap);
                        setRecapCopied(true);
                        setTimeout(() => setRecapCopied(false), 2500);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0"
                      style={{background:'rgba(139,92,246,0.15)',border:'1px solid rgba(139,92,246,0.3)',color:recapCopied?'#34d399':'#c4b5fd'}}>
                      {recapCopied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy for Group Chat</>}
                    </button>
                  </div>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{color:'rgba(226,232,240,0.85)'}}>
                    {archive.recap}
                  </div>
                  <div className="mt-3 pt-3 text-xs" style={{borderTop:'1px solid rgba(255,255,255,0.05)',color:'rgba(148,163,184,0.25)'}}>
                    Generated {new Date(archive.generatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                    {' · '}{archive.lockedBy ? `by ${archive.lockedBy}` : ''}
                  </div>
                </div>
              )}

            </div>
          )}
        </section>}

        {/* ── All-Time Section ── */}
        {activeTab === 'alltime' && <section>
          <div className="mb-6">
            <p className="text-xs uppercase tracking-widest font-semibold mb-1" style={{color:'rgba(148,163,184,0.5)'}}>All-Time Records</p>
            <h1 className="font-bebas text-4xl tracking-widest text-white flex items-center gap-3">
              <Trophy size={32} style={{color:'#C9A227'}} /> Season History
            </h1>
            <p className="text-sm mt-1" style={{color:'rgba(148,163,184,0.4)'}}>
              2019–present · Picks from historical spreadsheet · Scores auto-locked every Monday at 8 pm ET
            </p>
          </div>

          {/* Sub-toggle: Managers vs Golfers */}
          <div className="flex gap-2 mb-5">
            {(['managers', 'golfers'] as const).map(v => (
              <button key={v} onClick={() => setAllTimeView(v)}
                className="px-4 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all"
                style={allTimeView === v
                  ? { background: '#1B3A9E', color: '#fff', border: '1px solid rgba(27,58,158,0.6)' }
                  : { background: 'rgba(255,255,255,0.05)', color: 'rgba(148,163,184,0.6)', border: '1px solid rgba(255,255,255,0.07)' }
                }>
                {v === 'managers' ? '👤 Managers' : '⛳ Golfers'}
              </button>
            ))}
          </div>

          {allTimeView === 'managers' && (fetching ? (
            <div className="space-y-4">
              {[1,2,3,4].map(i => <div key={i} className="skeleton h-20 rounded-xl" />)}
            </div>
          ) : yearGroups.length === 0 ? (
            <div className="card text-center py-16">
              <p className="text-white font-semibold mb-1">No history yet</p>
              <p className="text-sm" style={{color:'rgba(148,163,184,0.5)'}}>
                Gibbs can import all historical picks from Admin → Users tab.
              </p>
            </div>
          ) : (
            <div className="space-y-6">

            {/* Team analysis: titles, records, tendencies, head-to-head */}
            {teamData && teamData.managers?.length > 0 && (
              <TeamAnalysis data={teamData} appUsername={appUser.username} view={teamAnalysis} setView={setTeamAnalysis} />
            )}
            {!teamData && (
              <div className="card text-center py-6 text-sm" style={{color:'rgba(148,163,184,0.4)'}}>
                Career manager analytics appear once Gibbs runs <strong>Refresh All-Time Golfer Stats</strong> in Admin.
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

              {/* All-time stats */}
              <div className="lg:col-span-1">
                <div className="card sticky top-20">
                  <h2 className="font-bebas text-xl tracking-wider text-white mb-4 flex items-center gap-2">
                    <Users size={16} style={{color:'#C9A227'}} /> All-Time Leaders
                  </h2>
                  {stats.length === 0 ? (
                    <p className="text-sm italic" style={{color:'rgba(148,163,184,0.5)'}}>
                      Stats populate once tournament scores are locked.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        {stats.map((s, i) => {
                          const isMe = s.username === appUser.username;
                          return (
                            <div key={s.username} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
                              style={isMe ? {background:'rgba(0,107,182,0.2)',border:'1px solid rgba(0,107,182,0.4)'} : {background:'rgba(255,255,255,0.04)'}}>
                              <span className="w-5 text-center shrink-0 text-xs" style={{color:'rgba(148,163,184,0.4)'}}>{i+1}.</span>
                              <span className="flex-1 font-semibold text-white truncate">{s.username}</span>
                              <div className="text-right shrink-0">
                                <div className="font-mono font-bold text-sm" style={{color: s.total < 0 ? '#34d399' : '#94a3b8'}}>
                                  {s.total > 0 ? '+' : ''}{s.total}
                                </div>
                                <div className="text-xs" style={{color:'rgba(148,163,184,0.35)'}}>
                                  {s.count}T · {s.wins}W · {s.podiums}🏅
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-xs pt-2" style={{color:'rgba(148,163,184,0.25)'}}>
                        Score = sum of top-3 player positions across locked tournaments. Lower is better.
                      </p>
                    </>
                  )}
                </div>
              </div>

              {/* Year groups */}
              <div className="lg:col-span-2 space-y-2">
                {yearGroups.map((yg) => {
                  const isYearOpen = expandedYear === yg.year;
                  const lockedCount = yg.tournaments.filter(t => t.locked).length;

                  return (
                    <div key={yg.year}>
                      <button
                        onClick={() => setExpandedYear(isYearOpen ? null : yg.year)}
                        className="w-full flex items-center justify-between px-4 py-3 rounded-xl mb-1 transition-all"
                        style={{
                          background: isYearOpen ? 'rgba(201,162,39,0.1)' : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${isYearOpen ? 'rgba(201,162,39,0.25)' : 'rgba(255,255,255,0.06)'}`,
                        }}>
                        <div className="flex items-center gap-3">
                          <span className="font-bebas text-2xl tracking-widest text-white">{yg.year}</span>
                          <span className="text-xs" style={{color:'rgba(148,163,184,0.4)'}}>
                            {yg.tournaments.length} event{yg.tournaments.length !== 1 ? 's' : ''}
                            {lockedCount > 0 && <span style={{color:'#C9A227'}}> · {lockedCount} scored</span>}
                          </span>
                        </div>
                        {isYearOpen
                          ? <ChevronDown size={15} style={{color:'rgba(148,163,184,0.4)'}} />
                          : <ChevronRight size={15} style={{color:'rgba(148,163,184,0.4)'}} />}
                      </button>

                      {isYearOpen && (
                        <div className="space-y-2 pl-2">
                          {yg.tournaments.map((tourn) => {
                            const isOpen = expandedTourn === tourn.key;
                            const showPicks = expandedPicks === tourn.key;
                            const hasLocked = !!tourn.locked;
                            const hasHist   = !!tourn.historical;

                            return (
                              <div key={tourn.key} className="card transition-all"
                                style={hasLocked ? {borderColor:'rgba(201,162,39,0.2)'} : {}}>

                                <button className="w-full flex items-center justify-between gap-3 text-left"
                                  onClick={() => setExpandedTourn(isOpen ? null : tourn.key)}>
                                  <div className="flex items-center gap-2 min-w-0">
                                    <Calendar size={13} style={{color: hasLocked ? '#C9A227' : 'rgba(148,163,184,0.35)', flexShrink:0}} />
                                    <span className="font-semibold text-white truncate text-sm">{tourn.name}</span>
                                    {hasLocked && (
                                      <span className="flex items-center gap-1 shrink-0 text-xs px-1.5 py-0.5 rounded font-semibold"
                                        style={{background:'rgba(201,162,39,0.12)',color:'#C9A227',border:'1px solid rgba(201,162,39,0.25)'}}>
                                        <Lock size={9} /> Scored
                                      </span>
                                    )}
                                    {!hasLocked && hasHist && (
                                      <span className="shrink-0 text-xs px-1.5 py-0.5 rounded"
                                        style={{background:'rgba(255,255,255,0.05)',color:'rgba(148,163,184,0.4)'}}>
                                        Picks only
                                      </span>
                                    )}
                                  </div>
                                  {isOpen
                                    ? <ChevronDown size={13} style={{color:'rgba(148,163,184,0.4)',flexShrink:0}} />
                                    : <ChevronRight size={13} style={{color:'rgba(148,163,184,0.4)',flexShrink:0}} />}
                                </button>

                                {isOpen && (
                                  <div className="mt-4 pt-4" style={{borderTop:'1px solid rgba(255,255,255,0.07)'}}>

                                    {/* Locked final standings */}
                                    {hasLocked && tourn.locked!.teamScores?.length > 0 && (
                                      <div className="mb-4">
                                        <div className="flex items-center justify-between mb-2">
                                          <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)'}}>
                                            Final Standings
                                          </p>
                                          <p className="text-xs" style={{color:'rgba(201,162,39,0.5)'}}>
                                            {new Date(tourn.locked!.lockedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                                            {' · '}{tourn.locked!.lockedBy === 'cron-monday-8pm' ? 'auto-locked' : 'manually locked'}
                                          </p>
                                        </div>
                                        <div className="space-y-1">
                                          {[...tourn.locked!.teamScores].sort((a,b) => a.rank-b.rank).map((ts) => {
                                            const isMe = ts.username === appUser.username;
                                            return (
                                              <div key={ts.userId} className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
                                                style={isMe ? {background:'rgba(0,107,182,0.2)',border:'1px solid rgba(0,107,182,0.3)'} : {background:'rgba(255,255,255,0.03)'}}>
                                                <span className="w-7 text-center shrink-0">{rankIcon(ts.rank)}</span>
                                                <span className="flex-1 font-semibold text-white">{ts.username}</span>
                                                <span className="font-mono font-bold text-sm shrink-0"
                                                  style={{color: ts.top3Score < 0 ? '#f87171' : '#94a3b8'}}>
                                                  {ts.top3Score > 0 ? '+' : ''}{ts.top3Score}
                                                </span>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    )}

                                    {/* Historical picks toggle */}
                                    {hasHist && (
                                      <div>
                                        <button
                                          onClick={() => setExpandedPicks(showPicks ? null : tourn.key)}
                                          className="flex items-center gap-1.5 text-xs mb-2 transition-colors hover:text-white"
                                          style={{color:'rgba(148,163,184,0.45)'}}>
                                          {showPicks ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
                                          {hasLocked ? 'View draft picks' : `Draft picks · ${tourn.historical!.picksPerUser} per team`}
                                        </button>

                                        {showPicks && (
                                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                            {tourn.historical!.users.map((username) => {
                                              const data = tourn.historical!.picksByUser[username];
                                              if (!data) return null;
                                              const isMe = username === appUser.username;
                                              const scores = tourn.historical!.playerScores?.[username] ?? {};
                                              return (
                                                <div key={username} className="rounded-lg p-2.5"
                                                  style={{
                                                    background: isMe ? 'rgba(0,107,182,0.1)' : 'rgba(255,255,255,0.04)',
                                                    border: `1px solid ${isMe ? 'rgba(0,107,182,0.25)' : 'rgba(255,255,255,0.06)'}`,
                                                  }}>
                                                  <p className="text-xs font-bold mb-1.5 truncate"
                                                    style={{color: isMe ? '#C9A227' : '#94a3b8'}}>
                                                    {username}
                                                  </p>
                                                  <ul className="space-y-0.5">
                                                    {data.picks.map((p, i) => {
                                                      const pos = scores[p.playerName];
                                                      return (
                                                        <li key={i} className="text-xs flex items-center justify-between gap-1">
                                                          <span className="text-slate-300 truncate">{p.playerName}</span>
                                                          {pos !== undefined && (
                                                            <span className="shrink-0 font-mono text-xs"
                                                              style={{color: pos <= 10 ? '#4ade80' : pos <= 30 ? '#facc15' : '#64748b'}}>
                                                              T{pos}
                                                            </span>
                                                          )}
                                                        </li>
                                                      );
                                                    })}
                                                  </ul>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                        {!hasLocked && !showPicks && (
                                          <p className="text-xs italic" style={{color:'rgba(148,163,184,0.3)'}}>
                                            Final scores weren't recorded for this event — picks preserved from the original spreadsheet.
                                          </p>
                                        )}
                                      </div>
                                    )}

                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

            </div>
            </div>
          ))}

          {(() => {
            // Available seasons from the performance log (newest first)
            const yearsSet = new Set<number>();
            for (const g of allTimeGolferStats) for (const p of g.performances ?? []) if (p.year) yearsSet.add(p.year);
            const years = [...yearsSet].sort((a, b) => b - a);

            const baseGolfers = golferSeason === 'all' ? allTimeGolferStats : golfersForSeason(allTimeGolferStats, golferSeason);
            const sortedGolfers = [...baseGolfers].sort((a, b) => {
              if (golferSort === 'drafted') return b.timesDrafted - a.timesDrafted;
              if (golferSort === 'avg') return a.avgPoints - b.avgPoints;
              if (golferSort === 'pick') return a.avgPickSpot - b.avgPickSpot;
              if (golferSort === 'slot') return b.slotPerformance - a.slotPerformance;
              return a.totalPoints - b.totalPoints;
            });
            const visibleGolfers = golferShowAll ? sortedGolfers : sortedGolfers.slice(0, 50);
            const scopeLabel = golferSeason === 'all' ? 'all seasons' : `${golferSeason} season`;
            return allTimeView === 'golfers' && (
              allTimeGolferStats.length === 0 ? (
                <div className="card text-center py-8 text-sm" style={{color:'rgba(148,163,184,0.4)'}}>
                  No all-time golfer stats yet. Ask Gibbs to run <strong>Refresh All-Time Golfer Stats</strong> in the Admin panel.
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Season scope selector */}
                  <div className="flex flex-wrap gap-1.5">
                    <button onClick={() => setGolferSeason('all')}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all"
                      style={golferSeason === 'all'
                        ? { background: '#1B3A9E', color: '#fff' }
                        : { background: 'rgba(255,255,255,0.05)', color: 'rgba(148,163,184,0.6)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      All-Time
                    </button>
                    {years.map(y => (
                      <button key={y} onClick={() => setGolferSeason(y)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all"
                        style={golferSeason === y
                          ? { background: '#1B3A9E', color: '#fff' }
                          : { background: 'rgba(255,255,255,0.05)', color: 'rgba(148,163,184,0.6)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        {y}
                      </button>
                    ))}
                  </div>

                  <div className="card" style={{padding:0}}>
                    <div className="px-4 pt-4 pb-3" style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                      <h3 className="font-bebas text-xl tracking-wider text-white flex items-center gap-2">
                        ⛳ Golfer Stats {golferSeason !== 'all' && <span className="text-sm" style={{color:'#E8C94A'}}>· {golferSeason}</span>}
                      </h3>
                      <p className="text-xs mt-0.5" style={{color:'rgba(148,163,184,0.4)'}}>
                        {sortedGolfers.length} golfers drafted across {scopeLabel} · Slot = value vs draft position · tap headers to sort
                      </p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[620px]">
                        <thead>
                          <tr style={{borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
                            <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wider w-8" style={{color:'rgba(148,163,184,0.4)'}}>#</th>
                            <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)'}}>Golfer</th>
                            {[
                              { key: 'drafted', label: 'Drafted' },
                              { key: 'pick',    label: 'Avg Pick' },
                              { key: 'total',   label: 'Total Pts' },
                              { key: 'avg',     label: 'Avg Pts' },
                              { key: 'slot',    label: 'Slot' },
                            ].map(col => (
                              <th key={col.key}
                                onClick={() => setGolferSort(col.key as typeof golferSort)}
                                className="text-center px-3 py-2.5 text-xs font-semibold uppercase tracking-wider cursor-pointer select-none transition-colors hover:text-white"
                                style={{color: golferSort === col.key ? '#E8C94A' : 'rgba(148,163,184,0.4)'}}>
                                {col.label}{golferSort === col.key ? ' ▲' : ''}
                              </th>
                            ))}
                            <th className="text-center px-3 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)'}}>Best</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleGolfers.map((g, i) => (
                            <tr key={g.playerName} style={{borderBottom:'1px solid rgba(255,255,255,0.03)'}}>
                              <td className="px-3 py-2 text-xs font-mono" style={{color:'rgba(148,163,184,0.3)'}}>{i+1}.</td>
                              <td className="px-3 py-2 font-semibold text-white text-sm whitespace-nowrap">{g.playerName}</td>
                              <td className="px-3 py-2 text-center">
                                <span className="text-xs font-mono" style={{color: g.timesDrafted >= 5 ? '#E8C94A' : g.timesDrafted >= 3 ? '#facc15' : 'rgba(148,163,184,0.5)'}}>
                                  {g.timesDrafted}×
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="text-xs font-mono" style={{color:'rgba(148,163,184,0.5)'}}>#{g.avgPickSpot}</span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="font-mono font-bold text-sm" style={{color: g.totalPoints < 0 ? '#34d399' : g.totalPoints < 40 ? '#facc15' : '#94a3b8'}}>
                                  {g.totalPoints > 0 ? '+' : ''}{g.totalPoints}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="font-mono text-xs" style={{color: g.avgPoints < 0 ? '#34d399' : 'rgba(148,163,184,0.5)'}}>
                                  {g.avgPoints > 0 ? '+' : ''}{g.avgPoints}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <SlotBadge v={g.slotPerformance} />
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="text-xs font-mono font-bold" style={{color: g.bestPositionNumeric <= 5 ? '#34d399' : g.bestPositionNumeric <= 15 ? '#facc15' : '#94a3b8'}}>
                                  {g.bestFinish}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!golferShowAll && sortedGolfers.length > 50 && (
                      <button
                        onClick={() => setGolferShowAll(true)}
                        className="w-full py-3 text-xs transition-colors hover:text-white"
                        style={{color:'rgba(148,163,184,0.35)',borderTop:'1px solid rgba(255,255,255,0.05)'}}>
                        Show all {sortedGolfers.length} golfers
                      </button>
                    )}
                    {allTimeGolferStats.length > 0 && (
                      <div className="px-4 py-2 text-xs" style={{borderTop:'1px solid rgba(255,255,255,0.04)',color:'rgba(148,163,184,0.2)'}}>
                        Updated {new Date(allTimeGolferStats[0]?.lastUpdated ?? 0).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                      </div>
                    )}
                  </div>
                </div>
              )
            );
          })()}
        </section>}

      </main>
    </div>
  );
}
