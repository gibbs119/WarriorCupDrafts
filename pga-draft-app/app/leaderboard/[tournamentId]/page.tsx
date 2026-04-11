'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import confetti from 'canvas-confetti';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import TournamentHero from '@/components/TournamentHero';
import TournamentAudio from '@/components/TournamentAudio';
import { getTournamentTheme } from '@/lib/tournament-theme';
import {
  getTournament,
  getDraftState,
  getAllUsers,
  savePlayers,
  saveRoundPositionSnapshot,
  getRoundPositionSnapshot,
  saveRoundStartBaseline,
  getRoundStartBaseline,
  saveTrendSnapshot,
  getTrendSnapshots,
  getOddsSnapshots,
  getLiveOdds,
  getReedRuleStatus,
  type TrendSnapshot,
  type OddsSnapshot,
} from '@/lib/db';
import { calculateLeaderboard } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import type { Tournament, TeamScore, AppUser, Player } from '@/lib/types';
import { TOURNAMENT_TZ_OFFSETS } from '@/lib/constants';
import { RefreshCw, Wifi, WifiOff, AlertTriangle, BarChart2, List, TrendingUp, Activity, Globe, Percent, Users } from 'lucide-react';

// ─── Live odds type (mirrors app/api/ai/live-odds/route.ts) ──────────────────
interface LiveOdds {
  generatedAt: number;
  roundLabel: string;
  analysis: string;
  odds: {
    userId: string;
    username: string;
    winPct: number;
    trend: 'up' | 'down' | 'stable';
    insight: string;
  }[];
}

const REFRESH_INTERVAL_NORMAL_MS  = 60_000;
const REFRESH_INTERVAL_BACKOFF_MS = 90_000;
const MAX_FAILURES_BEFORE_BACKOFF = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive end-of-round-N positions from cumulative stroke scores in the ESPN data.
 * This is more reliable than the Firebase position snapshot because:
 *  - roundScores data is stable once rounds complete (never gets "contaminated")
 *  - The Firebase snapshot is saved on every page load, so mid-round loads overwrite it
 * maxRound: the CURRENT round (we derive positions for rounds 1..maxRound-1)
 */
function derivePrevRoundPositions(
  players: Record<string, Player>,
  maxRound: number
): Record<string, number | null> {
  const parse = (s: string | null | undefined): number | null => {
    if (!s || s === '—' || s === '-' || s === '--') return null;
    if (s === 'E') return 0;
    const n = parseInt(s.replace('+', ''), 10);
    return isNaN(n) ? null : n;
  };

  const ranked: { id: string; total: number }[] = [];
  for (const p of Object.values(players)) {
    // Sum rounds 1 through maxRound-1 (all completed rounds before the current one)
    let total = 0;
    let allPresent = true;
    for (let r = 0; r < maxRound - 1; r++) {
      const s = parse(p.roundScores?.[r]);
      if (s === null) { allPresent = false; break; }
      total += s;
    }
    if (allPresent && p.status !== 'wd' && p.status !== 'dq') {
      ranked.push({ id: p.id, total });
    }
  }

  ranked.sort((a, b) => a.total - b.total); // ascending: lower = better

  const posMap: Record<string, number | null> = {};
  for (let i = 0; i < ranked.length; i++) {
    posMap[ranked[i].id] = i > 0 && ranked[i].total === ranked[i - 1].total
      ? posMap[ranked[i - 1].id]!
      : i + 1;
  }
  for (const p of Object.values(players)) {
    if (!(p.id in posMap)) posMap[p.id] = null;
  }
  return posMap;
}

function fmtPts(pts: number): string {
  if (pts >= 9000) return '—';
  if (pts === 0) return 'E';
  return pts > 0 ? `+${pts}` : `${pts}`;
}

function ptsColor(pts: number): string {
  if (pts >= 9000) return '#475569';
  if (pts < 0) return '#34d399';
  return '#cbd5e1';
}

// Standard golf scorecard convention: red = under par, white = even, green = over par
function golfScoreColor(score: string | null | undefined): string {
  if (!score || score === '—' || score === '-') return '#475569';
  if (score === 'E') return '#e2e8f0';
  if (score.startsWith('-')) return '#f87171';  // under par → red
  return '#34d399';                              // over par → green
}

function RankBadge({ rank }: { rank: number }) {
  const base = 'flex items-center justify-center w-10 h-10 rounded-full font-bebas text-xl tracking-wide shrink-0';
  if (rank === 1) return <div className={base} style={{ background: '#D4AF37', color: '#0a0f1e' }}>1</div>;
  if (rank === 2) return <div className={base} style={{ background: '#C0C0C0', color: '#0a0f1e' }}>2</div>;
  if (rank === 3) return <div className={base} style={{ background: '#CD7F32', color: '#0a0f1e' }}>3</div>;
  return <div className={base} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#64748b' }}>{rank}</div>;
}

function StatusPill({ status }: { status: string }) {
  if (status === 'cut') return <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(251,146,60,0.15)', color: '#fb923c' }}>CUT</span>;
  if (status === 'wd')  return <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(100,116,139,0.15)', color: '#94a3b8' }}>WD</span>;
  if (status === 'dq')  return <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>DQ</span>;
  return null;
}

// ─── Mini sparkline per team ──────────────────────────────────────────────────

function MiniSparkline({ snapshots, userId }: { snapshots: TrendSnapshot[]; userId: string }) {
  const scores = snapshots.map(s => s.scores[userId]).filter((v): v is number => v !== undefined && v < 9000);
  if (scores.length < 2) return null;
  const W = 52; const H = 20; const PAD = 2;
  const mn = Math.min(...scores); const mx = Math.max(...scores);
  const rng = Math.max(mx - mn, 1);
  const pts = scores.map((s, i) => ({
    x: PAD + (i / (scores.length - 1)) * (W - PAD * 2),
    y: PAD + ((s - mn) / rng) * (H - PAD * 2),
  }));
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const lastScore = scores[scores.length - 1];
  const firstScore = scores[0];
  const color = lastScore < firstScore ? '#34d399' : lastScore > firstScore ? '#f87171' : '#475569';
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
      <circle cx={pts[pts.length-1].x} cy={pts[pts.length-1].y} r={2.5} fill={color} />
    </svg>
  );
}

// ─── Simple scoreboard row ────────────────────────────────────────────────────

function ScoreRow({
  team, isMe, hasScores, expanded, onToggle, cutLine, winPct, trend, flashClass, snapshots, playersMap,
}: {
  team: TeamScore; isMe: boolean; hasScores: boolean; expanded: boolean; onToggle: () => void; cutLine: number; winPct?: number; trend?: 'up' | 'down' | 'stable'; flashClass?: string; snapshots?: TrendSnapshot[]; playersMap?: Record<string, Player>;
}) {
  const top3 = team.players.filter(p => p.countsInTop3).sort((a, b) => a.points - b.points);

  return (
    <div
      onClick={onToggle}
      className={`cursor-pointer select-none transition-all duration-150 ${flashClass ?? ''}`}
      style={{
        background: isMe
          ? 'linear-gradient(135deg,rgba(212,175,55,0.09),rgba(13,31,92,0.55))'
          : 'rgba(255,255,255,0.025)',
        border: isMe ? '1px solid rgba(212,175,55,0.28)' : '1px solid rgba(255,255,255,0.07)',
        borderRadius: expanded ? '12px 12px 0 0' : '12px',
        padding: '14px 18px',
      }}
    >
      <div className="flex items-center gap-3">
        <RankBadge rank={team.rank} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bebas text-xl tracking-wider" style={{ color: isMe ? '#D4AF37' : 'white' }}>
              {team.username}
            </span>
            {isMe && (
              <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(212,175,55,0.15)', color: '#D4AF37' }}>YOU</span>
            )}
          </div>
          {hasScores && top3.length > 0 ? (
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {top3.map((p, i) => (
                <span key={p.playerId} className="text-xs flex items-center gap-1">
                  <span className="font-bold" style={{ color: ptsColor(p.points) }}>
                    {p.positionDisplay !== '-' ? p.positionDisplay : '—'}
                  </span>
                  {p.positionChange !== null && p.currentRound > 1 && (
                    <span style={{
                      color: p.positionChange > 0 ? '#34d399' : p.positionChange < 0 ? '#f87171' : '#64748b',
                      fontSize: '9px',
                    }}>
                      {p.positionChange > 0 ? '▲' : p.positionChange < 0 ? '▼' : ''}
                    </span>
                  )}
                  <CutBubble position={p.position} cutLine={cutLine} status={p.status} thru={p.thru} />
                  <span className="text-slate-500">{p.playerName.split(' ').pop()}</span>
                  {i < top3.length - 1 && <span className="text-slate-700">·</span>}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-xs text-slate-600">
              {hasScores ? 'No scores yet' : (() => {
                if (!playersMap) return 'Awaiting tee-off';
                const teeTimes = team.players
                  .map(p => playersMap[p.playerId]?.teeTime)
                  .filter((t): t is string => !!t)
                  .map(t => new Date(t).getTime())
                  .filter(t => !isNaN(t))
                  .sort((a, b) => a - b);
                if (teeTimes.length === 0) return 'Awaiting tee-off';
                return `First tee: ${fmtTeeTime(new Date(teeTimes[0]).toISOString())}`;
              })()}
            </span>
          )}
        </div>
        {snapshots && snapshots.length >= 2 && (
          <div className="hidden sm:block shrink-0 mr-1">
            <MiniSparkline snapshots={snapshots} userId={team.userId} />
          </div>
        )}
        <div className="text-right shrink-0">
          {team.disqualified ? (
            <>
              <div className="font-mono font-bold text-2xl" style={{ color: '#f87171' }}>DQ</div>
              <div className="text-xs font-bold" style={{ color: '#f87171' }}>🚩 REED RULE</div>
            </>
          ) : (
            <>
              <div className="font-mono font-bold text-2xl" style={{ color: ptsColor(hasScores ? team.top3Score : 9999) }}>
                {hasScores ? fmtPts(team.top3Score) : '—'}
              </div>
              {winPct !== undefined
                ? <div className="text-xs font-bold flex items-center gap-0.5" style={{ color: trend === 'up' ? '#34d399' : trend === 'down' ? '#f87171' : 'rgba(201,162,39,0.85)' }}>
                    {winPct}% win
                    {trend === 'up' && <span style={{ fontSize: '9px' }}>↑</span>}
                    {trend === 'down' && <span style={{ fontSize: '9px' }}>↓</span>}
                  </div>
                : <div className="text-xs text-slate-600">pts</div>
              }
            </>
          )}
        </div>
        <div className="text-slate-600 text-xs ml-1">{expanded ? '▲' : '▼'}</div>
      </div>
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function fmtTeeTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch { return ''; }
}

function DetailPanel({ team, isMe, cutLine, standalone, playersMap }: {
  team: TeamScore; isMe: boolean; cutLine: number; standalone?: boolean;
  playersMap?: Record<string, Player>;
}) {
  const sorted = [...team.players].sort((a, b) => a.points - b.points);
  const hasAnyLiveScore = sorted.some(p => p.points < 9000);

  return (
    <div style={{
      background: standalone ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.25)',
      border: team.disqualified ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(255,255,255,0.07)',
      borderTop: standalone ? undefined : 'none',
      borderRadius: standalone ? '12px' : '0 0 12px 12px',
      overflow: 'hidden',
    }}>
      {/* Reed Rule DQ banner */}
      {team.disqualified && (
        <div className="px-5 py-2.5 flex items-center gap-2 text-sm font-bold"
          style={{ background: 'rgba(239,68,68,0.12)', borderBottom: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}>
          🚩 REED RULE — Team disqualified · All scores forfeited
        </div>
      )}
      {/* Owner header — only in standalone Detail tab */}
      {standalone && (
        <div className="flex items-center justify-between px-5 py-3" style={{
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          background: isMe ? 'rgba(27,58,158,0.25)' : 'rgba(255,255,255,0.02)',
        }}>
          <div className="flex items-center gap-2">
            <RankBadge rank={team.rank} />
            <span className="font-bebas text-lg tracking-wider" style={{ color: isMe ? '#D4AF37' : '#e2e8f0' }}>
              {team.username}
            </span>
            {isMe && (
              <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(27,58,158,0.4)', color: '#93bbfc' }}>YOU</span>
            )}
          </div>
          {team.disqualified
            ? <span className="font-mono font-bold text-xl" style={{ color: '#f87171' }}>DQ</span>
            : hasAnyLiveScore && (
                <span className="font-mono font-bold text-xl" style={{ color: ptsColor(team.top3Score) }}>
                  {fmtPts(team.top3Score)}
                </span>
              )
          }
        </div>
      )}

      {sorted.map((p, idx) => {
        const isCounting = p.countsInTop3;
        const pending    = p.points >= 9000;
        const posColor   = pending ? '#475569'
          : p.status !== 'active' ? '#fb923c'
          : p.position !== null && p.position <= 5 ? '#34d399'
          : '#cbd5e1';

        return (
          <div
            key={p.playerId}
            className="flex items-center gap-3 px-5 py-3"
            style={{
              borderBottom: idx < sorted.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              opacity: isCounting ? 1 : 0.38,
            }}
          >
            <div className="w-1 h-8 rounded-full shrink-0" style={{ background: isCounting ? '#D4AF37' : 'rgba(255,255,255,0.08)' }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium text-white">{p.playerName}</span>
                <StatusPill status={p.status} />
                <CutBubble position={p.position} cutLine={cutLine} status={p.status} thru={p.thru} />
                {isCounting && <span className="text-xs" style={{ color: 'rgba(212,175,55,0.65)' }}>★</span>}
              </div>
              <div className="text-xs text-slate-600 mt-0.5">
                {pending ? (() => {
                  const raw = playersMap?.[p.playerId]?.teeTime;
                  const formatted = raw ? fmtTeeTime(raw) : '';
                  return formatted ? `Tees off ${formatted}` : 'Not yet started';
                })()
                  : p.status === 'cut' ? `Cut line — scores ${p.points} pts`
                  : p.status === 'wd' || p.status === 'dq' ? `${p.status.toUpperCase()} — scores ${p.points} pts`
                  : p.thru === 'F' ? 'Round complete'
                  : p.thru !== '-' ? `Thru hole ${p.thru}`
                  : (() => {
                      const raw = playersMap?.[p.playerId]?.teeTime;
                      const fmt = raw ? fmtTeeTime(raw) : '';
                      return fmt ? `Tees off ${fmt}` : 'Tee time pending';
                    })()}
              </div>
              {!pending && (() => {
                const rs = playersMap?.[p.playerId]?.roundScores;
                const labels = ['R1','R2','R3','R4'];
                // Only show real stroke scores — skip null and placeholder '—'/'-' values
                const realScores = (rs ?? [])
                  .map((r, i) => ({ r, i }))
                  .filter((x): x is { r: string; i: number } =>
                    x.r !== null && x.r !== '—' && x.r !== '-' && x.r !== '--'
                  );
                if (!realScores.length) return null;
                return (
                  <div className="flex items-center gap-2 mt-0.5">
                    {realScores.map(({ r, i }) => (
                      <span key={i} className="text-xs">
                        <span className="text-slate-700">{labels[i]} </span>
                        <span className="font-mono" style={{ color: golfScoreColor(r) }}>{r}</span>
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
            {!pending && (
              <div className="text-right shrink-0 w-8">
                <div className="text-xs text-slate-500">{p.thru !== '-' ? p.thru : '—'}</div>
                <div className="text-xs text-slate-700">thru</div>
              </div>
            )}

            {/* Score to par — current round + total (visual only) */}
            {!pending && (
              <div className="text-right shrink-0 w-10">
                {(() => {
                  const rs  = playersMap?.[p.playerId]?.roundScores;
                  const cr  = playersMap?.[p.playerId]?.currentRound ?? p.currentRound;
                  const rdScore = (rs && cr) ? rs[cr - 1] : null;
                  const showRd  = rdScore !== null && p.thru !== '-';
                  return (
                    <>
                      {showRd && (
                        <div className="text-xs font-mono" style={{ color: golfScoreColor(rdScore!) }}>
                          {rdScore}
                        </div>
                      )}
                      <div className={showRd ? 'text-xs font-mono text-slate-400' : 'text-sm font-bold font-mono'}
                        style={showRd ? {} : { color: golfScoreColor(p.score) }}>
                        {p.score}
                      </div>
                      <div className="text-xs text-slate-700">{showRd ? 'total' : 'golf'}</div>
                    </>
                  );
                })()}
              </div>
            )}
            <div className="text-right shrink-0 w-16">
              <div className="flex items-center justify-end gap-1">
                <div className="text-sm font-bold" style={{ color: posColor }}>
                  {pending ? '—'
                    : p.status === 'cut' ? 'CUT'
                    : p.status === 'wd'  ? 'WD'
                    : p.status === 'dq'  ? 'DQ'
                    : p.positionDisplay || '—'}
                </div>
              </div>
              <div className="text-xs text-slate-600">pos</div>
            </div>
            <div className="text-right shrink-0 w-10">
              <div className="text-sm font-bold font-mono" style={{ color: ptsColor(p.points) }}>
                {fmtPts(p.points)}
              </div>
              <div className="text-xs text-slate-600">pts</div>
            </div>
          </div>
        );
      })}

      <div className="px-5 py-2.5 flex items-center justify-between" style={{ background: 'rgba(0,0,0,0.15)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <span className="text-xs text-slate-600">
          <span style={{ color: 'rgba(212,175,55,0.6)' }}>★</span> = counts · best {Math.min(3, sorted.length)} of {sorted.length}
        </span>
        {team.disqualified
          ? <span className="text-xs font-mono font-bold" style={{ color: '#f87171' }}>DQ — forfeited</span>
          : hasAnyLiveScore && (
              <span className="text-xs font-mono font-bold" style={{ color: ptsColor(team.top3Score) }}>
                {fmtPts(team.top3Score)} team
              </span>
            )
        }
      </div>
    </div>
  );
}

// ─── Trend Chart ──────────────────────────────────────────────────────────────

const TEAM_COLORS = [
  '#D4AF37', '#34d399', '#60a5fa', '#f87171',
  '#a78bfa', '#fb923c', '#38bdf8', '#4ade80',
];

function TrendChart({ snapshots, teams, myUserId }: {
  snapshots: TrendSnapshot[];
  teams: TeamScore[];
  myUserId: string;
}) {
  if (snapshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 rounded-xl"
        style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
        <div className="text-3xl mb-3">📈</div>
        <div className="font-bebas text-lg tracking-wider text-slate-400">No trend data yet</div>
        <div className="text-xs text-slate-600 mt-1 text-center max-w-xs px-4">
          Hourly snapshots are recorded automatically once the tournament begins.
        </div>
      </div>
    );
  }

  // ── Layout constants ───────────────────────────────────────────────────────
  // Chart grows 44px per data point so all hours are readable.
  // Minimum 320px wide so a single point doesn't look weird.
  const PX_PER_POINT = 44;
  const PAD = { top: 20, right: 16, bottom: 40, left: 44 };
  const SVG_H = 230;
  const plotH = SVG_H - PAD.top - PAD.bottom;

  // plotW and SVG_W are derived from the number of snapshots so the chart
  // stretches automatically as new hours are added throughout the day.
  const plotW = Math.max(280, (snapshots.length - 1) * PX_PER_POINT);
  const SVG_W = plotW + PAD.left + PAD.right;

  // ── Dynamic Y range ────────────────────────────────────────────────────────
  // Recalculated on every render from ALL real scores across ALL snapshots.
  // Excludes 9999 sentinels. Pads 12% each side (min 3 pts) so lines never
  // sit right on the edge. Window is always at least 10 pts tall.
  const allRealScores = snapshots.flatMap(s =>
    Object.values(s.scores).filter((v): v is number => v < 9000)
  );

  if (allRealScores.length === 0) return null;

  const dataMin = Math.min(...allRealScores);
  const dataMax = Math.max(...allRealScores);
  const edgePad = Math.max(3, Math.ceil((dataMax - dataMin) * 0.12));
  const yMin    = dataMin - edgePad;
  const yMax    = dataMax + edgePad;
  const yRange  = Math.max(yMax - yMin, 10);

  // ── Coordinate helpers ────────────────────────────────────────────────────
  // toX: evenly spaces points across plotW; single point lands at centre
  const toX = (i: number): number =>
    PAD.left + (snapshots.length <= 1 ? plotW / 2 : (i / (snapshots.length - 1)) * plotW);

  // toY: maps a score to SVG Y. Returns null for sentinel values.
  const toY = (score: number): number | null => {
    if (score >= 9000) return null;
    return PAD.top + ((score - yMin) / yRange) * plotH;
  };

  // ── Grid lines ─────────────────────────────────────────────────────────────
  // Choose a clean interval (1/2/5/10) that gives roughly 4-6 lines.
  const rawInterval = yRange / 5;
  const gridInterval =
    rawInterval <= 1 ? 1 :
    rawInterval <= 2 ? 2 :
    rawInterval <= 5 ? 5 : 10;

  const gridLines: number[] = [];
  const gridStart = Math.ceil(yMin / gridInterval) * gridInterval;
  for (let v = gridStart; v <= yMax; v += gridInterval) gridLines.push(v);

  return (
    <div style={{ overflowX: 'auto', borderRadius: 8 }}>
      <svg
        width={SVG_W}
        height={SVG_H}
        style={{ display: 'block' }}
        aria-label="Team score trend chart"
      >
        {/* Grid lines */}
        {gridLines.map(v => {
          const y = toY(v);
          if (y === null) return null;
          const isZero = v === 0;
          return (
            <g key={v}>
              <line
                x1={PAD.left} y1={y}
                x2={PAD.left + plotW} y2={y}
                stroke={isZero ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)'}
                strokeWidth={isZero ? 1.5 : 1}
                strokeDasharray={isZero ? '4 3' : undefined}
              />
              <text
                x={PAD.left - 7} y={y + 4}
                textAnchor="end" fontSize="9"
                fill={isZero ? '#94a3b8' : '#475569'}
              >
                {v === 0 ? 'E' : v > 0 ? `+${v}` : `${v}`}
              </text>
            </g>
          );
        })}

        {/* Team lines + dots */}
        {teams.map((team, ti) => {
          const color = TEAM_COLORS[ti % TEAM_COLORS.length];
          const isMe  = team.userId === myUserId;

          // Build valid points for this team (skip hours where they had no score)
          const pts: { x: number; y: number }[] = [];
          snapshots.forEach((snap, si) => {
            const score = snap.scores[team.userId];
            if (score === undefined || score >= 9000) return;
            const y = toY(score);
            if (y === null) return;
            pts.push({ x: toX(si), y });
          });

          if (pts.length === 0) return null;

          const pathD = pts
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(' ');

          return (
            <g key={team.userId}>
              <path
                d={pathD}
                fill="none"
                stroke={color}
                strokeWidth={isMe ? 2.5 : 1.5}
                strokeOpacity={isMe ? 1 : 0.55}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {pts.map((p, i) => {
                const isLast = i === pts.length - 1;
                return (
                  <circle
                    key={i}
                    cx={p.x} cy={p.y}
                    r={isLast ? (isMe ? 4.5 : 3.5) : (isMe ? 2.5 : 2)}
                    fill={color}
                    fillOpacity={isLast ? (isMe ? 1 : 0.75) : (isMe ? 0.65 : 0.4)}
                  />
                );
              })}
            </g>
          );
        })}

        {/* X-axis labels — skip every other label when >9 points to avoid overlap */}
        {snapshots.map((snap, i) => {
          if (snapshots.length > 9 && i % 2 !== 0) return null;
          const x = toX(i);
          const [day, time] = snap.hour.split(' ');
          return (
            <g key={i}>
              <line
                x1={x} y1={PAD.top + plotH}
                x2={x} y2={PAD.top + plotH + 4}
                stroke="rgba(255,255,255,0.1)" strokeWidth="1"
              />
              <text x={x} y={SVG_H - 20} textAnchor="middle" fontSize="9" fill="#64748b">{day}</text>
              <text x={x} y={SVG_H - 9}  textAnchor="middle" fontSize="9" fill="#475569">{time}</text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-2 pt-3 pb-1">
        {teams.map((team, ti) => {
          const color = TEAM_COLORS[ti % TEAM_COLORS.length];
          const isMe  = team.userId === myUserId;
          const lastReal = [...snapshots].reverse().find(s => (s.scores[team.userId] ?? 9999) < 9000);
          const lastScore = lastReal?.scores[team.userId];
          return (
            <div key={team.userId} className="flex items-center gap-1.5 text-xs">
              <div style={{ width: 16, height: 2.5, borderRadius: 2, background: color, opacity: isMe ? 1 : 0.6 }} />
              <span style={{ color: isMe ? color : '#94a3b8', fontWeight: isMe ? 700 : 400 }}>
                {team.username}
              </span>
              {lastScore !== undefined && (
                <span className="font-mono" style={{ color: ptsColor(lastScore) }}>
                  {fmtPts(lastScore)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ─── Odds Trend Chart ─────────────────────────────────────────────────────────

function OddsTrendChart({ snapshots, teams, myUserId }: {
  snapshots: OddsSnapshot[];
  teams: TeamScore[];
  myUserId: string;
}) {
  if (snapshots.length === 0) return null;

  const PX_PER_POINT = 44;
  const PAD = { top: 20, right: 16, bottom: 40, left: 40 };
  const SVG_H = 200;
  const plotH = SVG_H - PAD.top - PAD.bottom;
  const plotW = Math.max(280, (snapshots.length - 1) * PX_PER_POINT);
  const SVG_W = plotW + PAD.left + PAD.right;

  // Y axis: 0–100 win%, rounded to nearest 10 for grid lines
  const allPcts = snapshots.flatMap(s => Object.values(s.odds).filter(v => v > 0));
  if (allPcts.length === 0) return null;
  const dataMax = Math.min(100, Math.max(...allPcts) + 10);
  const dataMin = Math.max(0,   Math.min(...allPcts) - 5);
  const yMin = Math.max(0,   Math.floor(dataMin / 10) * 10);
  const yMax = Math.min(100, Math.ceil(dataMax  / 10) * 10);
  const yRange = Math.max(yMax - yMin, 10);

  const toX = (i: number) =>
    PAD.left + (snapshots.length <= 1 ? plotW / 2 : (i / (snapshots.length - 1)) * plotW);
  const toY = (pct: number) =>
    PAD.top + ((yMax - pct) / yRange) * plotH;

  const gridLines: number[] = [];
  for (let v = yMin; v <= yMax; v += 10) gridLines.push(v);

  return (
    <div style={{ overflowX: 'auto', borderRadius: 8 }}>
      <svg width={SVG_W} height={SVG_H} style={{ display: 'block' }} aria-label="Win probability trend chart">
        {/* Grid lines */}
        {gridLines.map(v => {
          const y = toY(v);
          return (
            <g key={v}>
              <line
                x1={PAD.left} y1={y} x2={PAD.left + plotW} y2={y}
                stroke="rgba(255,255,255,0.05)" strokeWidth={1}
              />
              <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="9" fill="#475569">
                {v}%
              </text>
            </g>
          );
        })}

        {/* Team lines */}
        {teams.map((team, ti) => {
          const color = TEAM_COLORS[ti % TEAM_COLORS.length];
          const isMe  = team.userId === myUserId;

          const pts: { x: number; y: number }[] = [];
          snapshots.forEach((snap, si) => {
            const pct = snap.odds[team.userId];
            if (pct === undefined) return;
            pts.push({ x: toX(si), y: toY(pct) });
          });

          if (pts.length === 0) return null;

          const pathD = pts
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
            .join(' ');

          return (
            <g key={team.userId}>
              <path
                d={pathD} fill="none" stroke={color}
                strokeWidth={isMe ? 2.5 : 1.5}
                strokeOpacity={isMe ? 1 : 0.55}
                strokeLinecap="round" strokeLinejoin="round"
              />
              {pts.map((p, i) => {
                const isLast = i === pts.length - 1;
                return (
                  <circle key={i} cx={p.x} cy={p.y}
                    r={isLast ? (isMe ? 4.5 : 3.5) : (isMe ? 2.5 : 2)}
                    fill={color}
                    fillOpacity={isLast ? (isMe ? 1 : 0.75) : (isMe ? 0.65 : 0.4)}
                  />
                );
              })}
            </g>
          );
        })}

        {/* X-axis labels */}
        {snapshots.map((snap, i) => {
          if (snapshots.length > 9 && i % 2 !== 0) return null;
          const x = toX(i);
          const [day, time] = snap.hour.split(' ');
          return (
            <g key={i}>
              <line x1={x} y1={PAD.top + plotH} x2={x} y2={PAD.top + plotH + 4}
                stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
              <text x={x} y={SVG_H - 20} textAnchor="middle" fontSize="9" fill="#64748b">{day}</text>
              <text x={x} y={SVG_H - 9}  textAnchor="middle" fontSize="9" fill="#475569">{time}</text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 px-2 pt-3 pb-1">
        {teams.map((team, ti) => {
          const color  = TEAM_COLORS[ti % TEAM_COLORS.length];
          const isMe   = team.userId === myUserId;
          const latest = snapshots.length > 0
            ? snapshots[snapshots.length - 1].odds[team.userId]
            : undefined;
          return (
            <div key={team.userId} className="flex items-center gap-1.5 text-xs">
              <div style={{ width: 16, height: 2.5, borderRadius: 2, background: color, opacity: isMe ? 1 : 0.6 }} />
              <span style={{ color: isMe ? color : '#94a3b8', fontWeight: isMe ? 700 : 400 }}>
                {team.username}
              </span>
              {latest !== undefined && (
                <span className="font-mono" style={{ color: '#94a3b8' }}>{latest}%</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Cut Bubble Badge ─────────────────────────────────────────────────────────

function CutBubble({ position, cutLine, status, thru }: {
  position: number | null; cutLine: number; status: string; thru: string;
}) {
  if (status !== 'active') return null;
  if (thru === '-') return null;
  if (position === null) return null;
  const danger  = position > cutLine;                        // already outside
  const bubble  = position >= cutLine - 4 && position <= cutLine; // within 5 of cut
  if (!danger && !bubble) return null;
  return (
    <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{
      background: danger ? 'rgba(239,68,68,0.15)' : 'rgba(234,179,8,0.12)',
      color:      danger ? '#f87171'              : '#ca8a04',
      fontSize:   '10px',
    }}>
      {danger ? 'DANGER' : 'BUBBLE'}
    </span>
  );
}

// ─── Today's Movers Panel ─────────────────────────────────────────────────────

function MoversPanel({
  teams, baseline, myUserId,
}: {
  teams: TeamScore[];
  baseline: Record<string, { score: number; rank: number }> | null;
  myUserId: string;
}) {
  if (teams.length === 0) {
    return (
      <div className="text-center py-16 text-slate-600 text-sm">
        No scores yet — check back once the round starts.
      </div>
    );
  }

  // Sort by biggest positive rank improvement (moved up most = first)
  const rows = teams.map(t => {
    const base      = baseline?.[t.userId];
    const rankDelta = base ? base.rank - t.rank : 0;   // positive = moved UP
    const scoreDelta= base ? base.score - t.top3Score : 0; // positive = improved (lower score)
    return { team: t, rankDelta, scoreDelta };
  }).sort((a, b) => b.rankDelta - a.rankDelta || b.scoreDelta - a.scoreDelta);

  return (
    <div className="rounded-xl overflow-hidden" style={{
      border: '1px solid rgba(255,255,255,0.07)',
      background: 'rgba(255,255,255,0.02)',
    }}>
      {/* Header */}
      <div className="px-4 pt-4 pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="font-bebas text-lg tracking-wider text-white mb-0.5">Today's Movers</div>
        <div className="text-xs text-slate-600">Position change & score delta since round start</div>
      </div>

      {/* Column headers */}
      <div className="grid px-4 py-2 text-xs text-slate-600 font-medium"
        style={{ gridTemplateColumns: '1fr 80px 80px 80px' }}>
        <span>Team</span>
        <span className="text-center">Now</span>
        <span className="text-center">Position</span>
        <span className="text-center">Score</span>
      </div>

      {rows.map(({ team, rankDelta, scoreDelta }, idx) => {
        const isMe = team.userId === myUserId;
        const rankColor  = rankDelta > 0 ? '#34d399' : rankDelta < 0 ? '#f87171' : '#475569';
        const scoreColor = scoreDelta > 0 ? '#34d399' : scoreDelta < 0 ? '#f87171' : '#475569';
        const rankLabel  = rankDelta === 0 ? '—'
          : rankDelta > 0 ? `▲${rankDelta}` : `▼${Math.abs(rankDelta)}`;
        const scoreLabel = scoreDelta === 0 ? '—'
          : scoreDelta > 0 ? `▲${scoreDelta}` : `▼${Math.abs(scoreDelta)}`;

        return (
          <div key={team.userId}
            className="grid items-center px-4 py-3"
            style={{
              gridTemplateColumns: '1fr 80px 80px 80px',
              borderBottom: idx < rows.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              background: isMe ? 'rgba(212,175,55,0.04)' : 'transparent',
            }}>
            {/* Name + rank */}
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex items-center justify-center w-7 h-7 rounded-full shrink-0 font-bebas text-base"
                style={{
                  background: team.rank === 1 ? '#D4AF37' : team.rank === 2 ? '#C0C0C0' : team.rank === 3 ? '#CD7F32' : 'rgba(255,255,255,0.06)',
                  color: team.rank <= 3 ? '#0a0f1e' : '#64748b',
                }}>
                {team.rank}
              </div>
              <span className="font-bebas text-base tracking-wide truncate"
                style={{ color: isMe ? '#D4AF37' : 'white' }}>
                {team.username}
              </span>
              {isMe && <span className="text-xs font-bold px-1 py-0.5 rounded shrink-0"
                style={{ background: 'rgba(212,175,55,0.15)', color: '#D4AF37', fontSize: '10px' }}>YOU</span>}
            </div>

            {/* Current score */}
            <div className="text-center font-mono font-bold text-sm" style={{ color: ptsColor(team.top3Score) }}>
              {fmtPts(team.top3Score)}
            </div>

            {/* Rank delta */}
            <div className="text-center font-bold text-sm" style={{ color: rankColor }}>
              {rankLabel}
            </div>

            {/* Score delta */}
            <div className="text-center font-bold text-sm font-mono" style={{ color: scoreColor }}>
              {scoreLabel}
            </div>
          </div>
        );
      })}

      <div className="px-4 py-2.5 text-xs text-slate-600"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        Position ▲ = moved up · Score ▲ = improved · Compared to round start
      </div>
    </div>
  );
}


// ─── Full Field Leaderboard ───────────────────────────────────────────────────

function FieldLeaderboard({
  players, draftedMap, cutLine,
}: {
  players: Record<string, Player>;
  draftedMap: Record<string, string>;
  cutLine: number;
}) {
  const [showCut, setShowCut] = React.useState(false);
  const [search, setSearch] = React.useState('');

  if (Object.keys(players).length === 0) {
    return (
      <div className="text-center py-16 text-slate-600 text-sm">
        Awaiting tee-off — check back once the round starts.
      </div>
    );
  }

  // Deduplicate — mergedMap contains both id-keyed and name-keyed entries for same player
  const seen = new Set<string>();
  const unique = Object.values(players).filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // Sort by position; unstarted players sorted by tee time; WD/DQ last
  const sorted = unique.sort((a, b) => {
    if (a.status === 'wd' || a.status === 'dq') return 1;
    if (b.status === 'wd' || b.status === 'dq') return -1;
    // Both not yet started → sort by tee time ascending
    if (a.position === null && b.position === null) {
      const ta = a.teeTime ? new Date(a.teeTime).getTime() : Infinity;
      const tb = b.teeTime ? new Date(b.teeTime).getTime() : Infinity;
      return ta - tb;
    }
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position - b.position;
  });

  const matchSearch = (p: Player) => search === '' || p.name.toLowerCase().includes(search.toLowerCase());
  const active = sorted.filter(p => p.status !== 'cut' && p.status !== 'wd' && p.status !== 'dq' && matchSearch(p));
  const cut    = sorted.filter(p => (p.status === 'cut' || p.status === 'wd' || p.status === 'dq') && matchSearch(p));

  const normName = (n: string) =>
    n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\./g,'').replace(/[-\u2013]/g,' ').replace(/\s+/g,' ').trim();

  function PlayerRow({ p, idx, total }: { p: Player; idx: number; total: number }) {
    const owner = draftedMap[normName(p.name)];
    const isDrafted = !!owner;
    const scoreColor = golfScoreColor(p.score);
    const isCut = p.status === 'cut';
    const isWdDq = p.status === 'wd' || p.status === 'dq';

    return (
      <div
        className="flex items-center px-3 py-2 gap-2"
        style={{
          borderBottom: idx < total - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
          background: isDrafted
            ? 'rgba(212,175,55,0.06)'
            : 'transparent',
        }}
      >
        {/* Position */}
        <div className="text-xs font-bold shrink-0 w-9 text-right"
          style={{ color: isDrafted ? '#D4AF37' : '#475569' }}>
          {isCut ? 'CUT' : isWdDq ? p.status.toUpperCase() : (p.positionDisplay || '—')}
        </div>

        {/* Name + owner tag + tee time */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm truncate" style={{
              color: isDrafted ? 'white' : '#94a3b8',
              fontWeight: isDrafted ? 600 : 400,
            }}>
              {p.name}
            </span>
            {isDrafted && (
              <span className="text-xs shrink-0 font-bold px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(212,175,55,0.15)', color: '#D4AF37', fontSize: '10px' }}>
                {owner}
              </span>
            )}
          </div>
          {p.thru === '-' && p.teeTime && (
            <div className="text-xs mt-0.5" style={{ color: '#475569' }}>
              Tees off {fmtTeeTime(p.teeTime)}
            </div>
          )}
        </div>

        {/* Thru */}
        <div className="text-xs shrink-0 w-7 text-right" style={{ color: '#475569' }}>
          {isWdDq ? '—' : (p.thru !== '-' ? p.thru : '—')}
        </div>

        {/* Score — current round + total (show for cut players too, for posterity) */}
        <div className="shrink-0 w-16 text-right">
          {isWdDq ? (
            <div className="text-sm font-bold font-mono text-slate-600">—</div>
          ) : (() => {
            const rdScore = p.roundScores?.[(p.currentRound ?? 1) - 1] ?? null;
            const showRd = rdScore !== null && p.thru !== '-';
            const scoreStyle = isCut ? { color: '#64748b' } : { color: scoreColor };
            return (
              <>
                {showRd && (
                  <div className="text-xs font-mono" style={isCut ? { color: '#64748b' } : { color: golfScoreColor(rdScore!) }}>
                    {rdScore}
                  </div>
                )}
                <div className={showRd ? 'text-xs font-mono text-slate-400' : 'text-sm font-bold font-mono'} style={showRd ? {} : scoreStyle}>
                  {p.score || '—'}
                </div>
                {showRd && <div className="text-xs text-slate-700" style={{ fontSize: '9px' }}>total</div>}
              </>
            );
          })()}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{
      border: '1px solid rgba(255,255,255,0.07)',
      background: 'rgba(255,255,255,0.02)',
    }}>
      {/* Search bar */}
      <div className="px-3 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.15)' }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search players…"
          className="input w-full text-sm"
          style={{ padding: '6px 10px' }}
        />
      </div>
      {/* Column headers */}
      <div className="flex items-center px-3 py-2 gap-2 text-xs font-medium"
        style={{ color: '#475569', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.2)' }}>
        <div className="w-9 text-right shrink-0">Pos</div>
        <div className="flex-1">Player</div>
        <div className="w-7 text-right shrink-0">Thru</div>
        <div className="w-16 text-right shrink-0">Rd / Tot</div>
      </div>

      {/* Active players */}
      {active.map((p, i) => (
        <React.Fragment key={p.id}>
          <PlayerRow p={p} idx={i} total={active.length} />
        </React.Fragment>
      ))}

      {/* Cut line divider + toggle */}
      {cut.length > 0 && (
        <>
          <button
            onClick={() => setShowCut(c => !c)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium"
            style={{
              background: 'rgba(251,146,60,0.07)',
              borderTop: '1px solid rgba(251,146,60,0.2)',
              borderBottom: showCut ? '1px solid rgba(251,146,60,0.1)' : 'none',
              color: '#fb923c',
            }}>
            <span>✂ CUT / WD / DQ — {cut.length} players</span>
            <span>{showCut ? '▲ hide' : '▼ show'}</span>
          </button>
          {showCut && cut.map((p, i) => (
            <React.Fragment key={p.id}>
              <PlayerRow p={p} idx={i} total={cut.length} />
            </React.Fragment>
          ))}
        </>
      )}

      <div className="px-3 py-2 text-xs flex items-center gap-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)', color: '#475569' }}>
        <span className="w-3 h-3 rounded-sm inline-block shrink-0" style={{ background: 'rgba(212,175,55,0.15)' }} />
        Highlighted = drafted player · name in badge = owner
      </div>
    </div>
  );
}

// ─── Odds Panel ───────────────────────────────────────────────────────────────

function OddsPanel({
  odds, myUserId, teams, loading, onRefresh, isAdmin,
}: {
  odds: LiveOdds | null;
  myUserId: string;
  teams: TeamScore[];
  loading: boolean;
  onRefresh: () => void;
  isAdmin: boolean;
}) {
  if (!odds && !loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 rounded-xl gap-4"
        style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
        <div className="text-4xl">🎲</div>
        <div className="text-center">
          <div className="font-bebas text-xl tracking-wider text-white mb-1">Live Odds Not Generated Yet</div>
          <p className="text-slate-500 text-xs max-w-xs mx-auto">
            {isAdmin
              ? 'Odds are generated automatically each hour. You can also generate them manually.'
              : 'Odds are generated automatically each hour alongside score updates.'}
          </p>
        </div>
        {isAdmin && (
          <button onClick={onRefresh}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={{ background: 'rgba(201,162,39,0.15)', color: '#C9A227', border: '1px solid rgba(201,162,39,0.3)' }}>
            <Percent size={13} /> Generate Odds Now
          </button>
        )}
      </div>
    );
  }

  if (loading && !odds) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="font-bebas text-xl tracking-widest animate-pulse" style={{ color: '#C9A227' }}>
          ANALYZING THE FIELD…
        </div>
        <p className="text-slate-500 text-xs">Crunching the numbers…</p>
      </div>
    );
  }

  if (!odds) return null;

  const sorted = [...odds.odds].sort((a, b) => b.winPct - a.winPct);
  const maxPct = Math.max(...sorted.map(o => o.winPct), 1);

  return (
    <div className="space-y-3">
      {/* Header card */}
      <div className="rounded-xl p-4"
        style={{ background: 'rgba(201,162,39,0.06)', border: '1px solid rgba(201,162,39,0.2)' }}>
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="flex items-center gap-2">
              <Percent size={14} style={{ color: '#C9A227' }} />
              <span className="font-bebas text-xl tracking-wider text-white">Live Win Odds</span>
              <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                style={{ background: 'rgba(201,162,39,0.15)', color: '#C9A227' }}>
                {odds.roundLabel}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Updated {new Date(odds.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={onRefresh}
              disabled={loading}
              className="p-1.5 rounded-lg transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: loading ? '#C9A227' : '#475569' }}
              title="Regenerate odds">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
        <p className="text-sm text-slate-300 leading-relaxed">{odds.analysis}</p>
      </div>

      {/* Per-team odds bars */}
      {sorted.map((o) => {
        const isMe = o.userId === myUserId;
        const teamIdx = teams.findIndex(t => t.userId === o.userId);
        const color = TEAM_COLORS[teamIdx >= 0 ? teamIdx % TEAM_COLORS.length : 0];
        const trendIcon = o.trend === 'up' ? '▲' : o.trend === 'down' ? '▼' : '—';
        const trendColor = o.trend === 'up' ? '#34d399' : o.trend === 'down' ? '#f87171' : '#475569';
        const barWidth = `${(o.winPct / maxPct) * 100}%`;
        const teamScore = teams.find(t => t.userId === o.userId);

        return (
          <div key={o.userId} className="rounded-xl overflow-hidden"
            style={{
              background: isMe
                ? 'linear-gradient(135deg,rgba(212,175,55,0.07),rgba(13,31,92,0.4))'
                : 'rgba(255,255,255,0.025)',
              border: isMe ? '1.5px solid rgba(212,175,55,0.28)' : '1px solid rgba(255,255,255,0.07)',
            }}>
            <div className="px-4 pt-3 pb-1">
              {/* Name row */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bebas text-lg tracking-wide" style={{ color: isMe ? '#D4AF37' : 'white' }}>
                    {o.username}
                  </span>
                  {isMe && (
                    <span className="text-xs font-bold px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(212,175,55,0.15)', color: '#D4AF37' }}>YOU</span>
                  )}
                  <span className="text-xs font-bold" style={{ color: trendColor }}>{trendIcon}</span>
                  {teamScore && (
                    <span className="text-xs text-slate-500 font-mono">
                      {fmtPts(teamScore.top3Score)}
                    </span>
                  )}
                </div>
                <span className="font-bebas text-2xl shrink-0" style={{ color }}>{o.winPct}%</span>
              </div>

              {/* Win % bar */}
              <div className="h-1.5 rounded-full mb-2" style={{ background: 'rgba(0,0,0,0.3)' }}>
                <div className="h-full rounded-full odds-bar"
                  style={{ width: barWidth, background: color }} />
              </div>

              {/* Insight */}
              <p className="text-xs text-slate-400 leading-relaxed pb-2">{o.insight}</p>
            </div>
          </div>
        );
      })}

      <p className="text-xs text-slate-700 text-center pt-1">
        AI-generated · updates hourly with live scores · powered by Gemini
      </p>
    </div>
  );
}

// ─── Rosters View ─────────────────────────────────────────────────────────────

function RostersView({ teams, myUserId, playersMap }: { teams: TeamScore[]; myUserId: string; playersMap?: Record<string, Player> }) {
  if (teams.length === 0) {
    return (
      <div className="text-center py-16 text-slate-600 text-sm">
        No roster data yet — check back once the draft is complete.
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {teams.map((team) => {
        const isMe = team.userId === myUserId;
        const sorted = [...team.players].sort((a, b) => (a.round ?? 99) - (b.round ?? 99));
        return (
          <div key={team.userId} className="rounded-xl overflow-hidden"
            style={{
              border: team.disqualified ? '1px solid rgba(239,68,68,0.4)' : isMe ? '1px solid rgba(212,175,55,0.35)' : '1px solid rgba(255,255,255,0.07)',
              background: team.disqualified ? 'rgba(239,68,68,0.04)' : isMe ? 'rgba(212,175,55,0.04)' : 'rgba(255,255,255,0.02)',
            }}>
            {/* Team header */}
            <div className="px-4 py-2.5 flex items-center justify-between"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.07)', background: team.disqualified ? 'rgba(239,68,68,0.08)' : isMe ? 'rgba(212,175,55,0.07)' : 'rgba(0,0,0,0.2)' }}>
              <div className="flex items-center gap-2">
                <RankBadge rank={team.rank} />
                <span className="font-bebas text-base tracking-wider" style={{ color: team.disqualified ? '#f87171' : isMe ? '#D4AF37' : 'white' }}>{team.username}</span>
                {isMe && !team.disqualified && <span className="text-xs font-bold px-1 py-0.5 rounded" style={{ background: 'rgba(212,175,55,0.15)', color: '#D4AF37', fontSize: '10px' }}>YOU</span>}
                {team.disqualified && <span className="text-xs font-bold px-1 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', fontSize: '10px' }}>🚩 REED RULE</span>}
              </div>
              <span className="font-mono font-bold text-sm" style={{ color: team.disqualified ? '#f87171' : ptsColor(team.top3Score) }}>
                {team.disqualified ? 'DQ' : fmtPts(team.top3Score)}
              </span>
            </div>
            {/* Picks */}
            {sorted.map((p, idx) => {
              const pending = p.points >= 9000;
              const isCounting = p.countsInTop3;
              return (
                <div key={p.playerId}
                  className="flex items-center gap-2 px-3 py-2"
                  style={{
                    borderBottom: idx < sorted.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                    opacity: isCounting ? 1 : 0.5,
                  }}>
                  <div className="w-4 shrink-0 text-center">
                    {isCounting
                      ? <span style={{ color: 'rgba(212,175,55,0.7)', fontSize: '10px' }}>★</span>
                      : <span className="text-slate-700" style={{ fontSize: '10px' }}>·</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" style={{ color: pending ? '#94a3b8' : 'white', fontWeight: isCounting ? 600 : 400 }}>
                      {p.playerName}
                    </div>
                    {/* Tee time: R1 not-yet-started (pending) OR R2/3/4 waiting for round */}
                    {(pending || p.thru === '-') && (() => {
                      const raw = playersMap?.[p.playerId]?.teeTime;
                      const fmt = raw ? fmtTeeTime(raw) : '';
                      return fmt
                        ? <div className="text-xs" style={{ color: '#475569' }}>Tees off {fmt}</div>
                        : null;
                    })()}
                  </div>
                  <StatusPill status={p.status} />
                  {!pending && (
                    <span className="text-xs font-bold shrink-0"
                      style={{ color: p.status !== 'active' ? '#fb923c' : p.position !== null && p.position <= 5 ? '#34d399' : '#cbd5e1' }}>
                      {p.status === 'cut' ? 'CUT' : p.status === 'wd' ? 'WD' : p.status === 'dq' ? 'DQ' : (p.positionDisplay || '—')}
                    </span>
                  )}
                  <span className="text-xs font-mono shrink-0 w-8 text-right" style={{ color: ptsColor(p.points) }}>
                    {fmtPts(p.points)}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LeaderboardPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const theme = getTournamentTheme(tournamentId);
  const { appUser, loading } = useAuth();
  const router = useRouter();

  const [tournament,         setTournament]         = useState<Tournament | null>(null);
  const [teamScores,         setTeamScores]         = useState<TeamScore[]>([]);
  const [users,              setUsers]              = useState<AppUser[]>([]);
  const [lastUpdated,        setLastUpdated]        = useState<Date | null>(null);
  const [refreshing,         setRefreshing]         = useState(false);
  const [view,               setView]               = useState<'simple' | 'detailed' | 'trend' | 'movers' | 'field' | 'odds' | 'rosters'>('simple');
  const [roundStartScores,   setRoundStartScores]   = useState<Record<string, { score: number; rank: number }> | null>(null);
  const [fieldPlayers,       setFieldPlayers]       = useState<Record<string, Player>>({});
  const [draftedMap,         setDraftedMap]         = useState<Record<string, string>>({});  // playerName.lower → username
  const [trendSnapshots,     setTrendSnapshots]     = useState<TrendSnapshot[]>([]);
  const [oddsSnapshots,      setOddsSnapshots]      = useState<OddsSnapshot[]>([]);
  const [expandedTeam,       setExpandedTeam]       = useState<string | null>(null);
  const [dataSource,         setDataSource]         = useState('');
  const [isStale,            setIsStale]            = useState(false);
  const [derivedCutLine,     setDerivedCutLine]     = useState<number>(65);
  const [fetchError,         setFetchError]         = useState<string | null>(null);
  const [prevRoundPositions, setPrevRoundPositions] = useState<Record<string, number | null> | null>(null);
  const [liveOdds,           setLiveOdds]           = useState<LiveOdds | null>(null);
  const [oddsLoading,        setOddsLoading]        = useState(false);
  const [reedRuleActive,     setReedRuleActive]     = useState(false);
  const reedRuleRef = useRef(false);

  const consecutiveFailures = useRef(0);
  const intervalRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasScoresRef        = useRef(false);
  const lastGoodUpdateRef   = useRef<Date | null>(null);
  const lastSnapshotHourRef = useRef<string>('');
  const lastOddsHourRef     = useRef<string>('');
  const detectedRoundRef             = useRef(1);
  const confettiFiredRef             = useRef(false);
  const prevScoresRef                = useRef<Record<string, number>>({});
  const roundStartBaselineLoadedRef  = useRef(false);
  const [scoreFlashes,      setScoreFlashes] = useState<Record<string, 'up' | 'down'>>({});
  const [secAgo,            setSecAgo]       = useState(0);

  // Live "Updated Xs ago" counter
  useEffect(() => {
    if (!lastUpdated) return;
    const tick = () => setSecAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  // Restore hourly dedup keys from sessionStorage so page reloads within the
  // same hour do NOT re-fire snapshot + odds generation.
  useEffect(() => {
    try {
      const savedSnap = sessionStorage.getItem(`lastSnapshotHour_${tournamentId}`);
      if (savedSnap) lastSnapshotHourRef.current = savedSnap;
      const savedOdds = sessionStorage.getItem(`lastOddsHour_${tournamentId}`);
      if (savedOdds) lastOddsHourRef.current = savedOdds;
    } catch { /* sessionStorage may be unavailable in some private modes */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [t, allUsers, snaps, oddsSnaps, cachedOdds, reedRule] = await Promise.all([
        getTournament(tournamentId),
        getAllUsers(),
        getTrendSnapshots(tournamentId),
        getOddsSnapshots(tournamentId),
        getLiveOdds(tournamentId),
        getReedRuleStatus(tournamentId),
      ]);
      setTournament(t);
      setUsers(allUsers);
      if (snaps.length > 0) setTrendSnapshots(snaps);
      if (oddsSnaps.length > 0) setOddsSnapshots(oddsSnaps);
      if (cachedOdds) setLiveOdds(cachedOdds as LiveOdds);
      setReedRuleActive(reedRule);
      reedRuleRef.current = reedRule;
    }
    load();
  }, [appUser, tournamentId]);

  const refreshScores = useCallback(
    async (t: Tournament, allUsers: AppUser[], isBust = false) => {
      if (!t.espnEventId) return;
      setRefreshing(true);
      setFetchError(null);
      try {
        const url = `/api/espn/leaderboard?eventId=${t.espnEventId}${isBust ? '&bust=1' : ''}`;
        const res = await fetch(url);
        const cacheStatus = res.headers.get('X-Cache') ?? '';
        const source      = res.headers.get('X-Cache-Source') ?? '';
        const cacheAge    = res.headers.get('X-Cache-Age');

        if (!res.ok) {
          consecutiveFailures.current++;
          if (hasScoresRef.current) {
            setIsStale(true);
          } else {
            const body = await res.json().catch(() => ({}));
            setFetchError(body.error ?? 'Scores temporarily unavailable. Retrying…');
          }
          return;
        }

        const data = await res.json();
        const { players: parsed, cutLine: espnCutLine } = parseLeaderboard(data);

        // Derive cut line from actual player data so we don't rely on ESPN's
        // detail text (often unparseable) or an admin-set override.
        // After the cut: active survivors hold positions 1..N → N is the cut line.
        // Before the cut: no cut-status players → fall back to ESPN-parsed value.
        const cutHasBeenMade = Object.values(parsed).some(p => p.status === 'cut');
        const cutLine = (() => {
          if (!cutHasBeenMade) return espnCutLine;
          const survivors = Object.values(parsed).filter(
            p => p.status === 'active' && p.position !== null
          ).length;
          return survivors > 0 ? survivors : espnCutLine;
        })();
        setDerivedCutLine(cutLine);

        if (Object.keys(parsed).length === 0) {
          consecutiveFailures.current++;
          if (hasScoresRef.current) {
            setIsStale(true);
          } else {
            setFetchError("No scores yet — tournament hasn't started.");
          }
          return;
        }

        consecutiveFailures.current = 0;
        setIsStale(cacheStatus === 'STALE');
        setDataSource(source);
        setFetchError(null);

        await savePlayers(tournamentId, parsed);

        const draftState = await getDraftState(tournamentId);
        if (!draftState) return;

        const userPicksMap: Record<string, { username: string; picks: typeof draftState.picks }> = {};
        for (const user of allUsers) {
          const picks = draftState.picks.filter(p => p.userId === user.uid);
          if (picks.length > 0) userPicksMap[user.uid] = { username: user.username, picks };
        }

        const mergedMap: Record<string, Player> = { ...parsed };
        for (const player of Object.values(parsed)) {
          const nameKey = player.name
            .toLowerCase().normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/\./g, '')
            .replace(/[-\u2013]/g, ' ').replace(/\s+/g, ' ').trim();
          mergedMap[nameKey] = player;
        }

        // ── Round-change detection ─────────────────────────────────────────
        const maxRound = Object.values(parsed).reduce((m, p) => Math.max(m, p.currentRound ?? 1), 1);
        let currentPrevPositions = prevRoundPositions;

        if (maxRound > detectedRoundRef.current) {
          const prevRound = maxRound - 1;
          // Derive prev-round positions from completed round-score data.
          // This is reliable at any point during the new round because roundScores
          // never change once a round is complete — unlike player.position, which
          // is mid-round and overwrites a clean snapshot on every page load.
          const derivedPositions = maxRound > 1
            ? derivePrevRoundPositions(parsed, maxRound)
            : {} as Record<string, number | null>;
          // Only write the snapshot if none exists yet — prevents mid-round page
          // loads from overwriting a snapshot that was already correctly saved.
          const existingSnap = await getRoundPositionSnapshot(tournamentId, prevRound);
          if (!existingSnap || Object.keys(existingSnap).length === 0) {
            await saveRoundPositionSnapshot(tournamentId, prevRound, derivedPositions);
          }
          detectedRoundRef.current = maxRound;
          setPrevRoundPositions(derivedPositions);
          currentPrevPositions = derivedPositions;
          // New round started — reset baseline so Movers tracks from this round's start
          roundStartBaselineLoadedRef.current = false;
          setRoundStartScores(null);
        } else if (maxRound > 1 && currentPrevPositions === null) {
          const fetched = await getRoundPositionSnapshot(tournamentId, maxRound - 1);
          if (fetched) { setPrevRoundPositions(fetched); currentPrevPositions = fetched; }
        }

        const scores = calculateLeaderboard(userPicksMap, mergedMap, cutLine, currentPrevPositions, reedRuleRef.current);
        setTeamScores(scores);

        // ── Score change flash detection ──────────────────────────────────
        const flashes: Record<string, 'up' | 'down'> = {};
        for (const s of scores) {
          const prev = prevScoresRef.current[s.userId];
          if (prev !== undefined && prev !== s.top3Score && s.top3Score < 9000) {
            flashes[s.userId] = s.top3Score < prev ? 'up' : 'down';
          }
        }
        if (Object.keys(flashes).length > 0) {
          setScoreFlashes(flashes);
          setTimeout(() => setScoreFlashes({}), 1500);
        }
        prevScoresRef.current = Object.fromEntries(scores.map(s => [s.userId, s.top3Score]));

        // Store full field for Field tab
        setFieldPlayers(mergedMap);
        // Build name→username map from draft picks
        const dm: Record<string, string> = {};
        for (const [, { username, picks }] of Object.entries(userPicksMap)) {
          for (const pick of picks) {
            dm[pick.playerName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\./g,'').replace(/[-\u2013]/g,' ').replace(/\s+/g,' ').trim()] = username;
          }
        }
        setDraftedMap(dm);

        // Mark scores as loaded BEFORE any optional Firebase calls that might fail,
        // so a permission-denied on roundStartScores doesn't trigger "Network error".
        hasScoresRef.current = true;

        // ── Round-start baseline for Movers panel ─────────────────────────
        // Load from Firebase once per round so reloading the page doesn't
        // reset the baseline to mid-round scores.
        // For round 2+, we prefer the prev-round position snapshot so the
        // baseline reflects end-of-R1 standings rather than mid-R2 scores.
        if (!roundStartBaselineLoadedRef.current) {
          roundStartBaselineLoadedRef.current = true;
          try {
            if (maxRound > 1) {
              // Round 2+: derive the prev-round standings directly from round-score data.
              // We intentionally bypass any saved Firebase baseline here because that
              // baseline may have been computed from mid-round scores (saved on a page
              // load that happened after the round had already started).  Round scores
              // are immutable once a round completes, so this derivation is always correct.
              const prevPositions = derivePrevRoundPositions(parsed, maxRound);
              const prevPlayers: Record<string, Player> = {};
              for (const [id, player] of Object.entries(parsed)) {
                prevPlayers[id] = { ...player, position: prevPositions[id] ?? null };
              }
              const baselineScores = calculateLeaderboard(userPicksMap, prevPlayers, cutLine, null, reedRuleRef.current);
              if (baselineScores.some(s => s.top3Score < 9000)) {
                const baseline: Record<string, { score: number; rank: number }> = {};
                baselineScores.forEach(s => { baseline[s.userId] = { score: s.top3Score, rank: s.rank }; });
                setRoundStartScores(baseline);
              } else {
                roundStartBaselineLoadedRef.current = false; // round scores not yet available — retry
              }
            } else {
              // Round 1: no prior round data exists — use Firebase baseline if saved,
              // otherwise anchor to the first refresh where real scores appear.
              const savedBaseline = await getRoundStartBaseline(tournamentId, maxRound);
              if (savedBaseline) {
                setRoundStartScores(savedBaseline);
              } else if (scores.some(s => s.top3Score < 9000)) {
                const baseline: Record<string, { score: number; rank: number }> = {};
                scores.forEach(s => { baseline[s.userId] = { score: s.top3Score, rank: s.rank }; });
                setRoundStartScores(baseline);
                saveRoundStartBaseline(tournamentId, maxRound, baseline).catch(() => {});
              } else {
                roundStartBaselineLoadedRef.current = false; // retry next refresh
              }
            }
          } catch {
            // Network error — reset so we retry on the next 60-second refresh
            roundStartBaselineLoadedRef.current = false;
          }
        }
        const now = new Date();
        setLastUpdated(now);
        lastGoodUpdateRef.current = now;
        if (cacheAge && parseInt(cacheAge, 10) > 180) setIsStale(true);

        // ── Hourly trend snapshot + live odds ─────────────────────────────
        // Use per-tournament timezone offset (default -4 for EDT).
        // Record one snapshot per hour, Thu–Sun 8 AM–8 PM local time,
        // only when at least one team has a real score (not the 9999 sentinel).
        const tzOffset = TOURNAMENT_TZ_OFFSETS[tournamentId] ?? -4;
        const nowLocal = new Date(now.getTime() + tzOffset * 60 * 60 * 1000);
        const dow      = nowLocal.getUTCDay();    // 0=Sun 4=Thu 5=Fri 6=Sat
        const hourLoc  = nowLocal.getUTCHours();

        const isTourDay  = dow === 4 || dow === 5 || dow === 6 || dow === 0;
        const isTourHour = hourLoc >= 8 && hourLoc <= 20;

        if (isTourDay && isTourHour && scores.some(s => s.top3Score < 9000)) {
          // Key is ISO-hour string e.g. "2026-03-12T14" — one snapshot per hour
          const hourKey = nowLocal.toISOString().slice(0, 13);
          if (hourKey !== lastSnapshotHourRef.current) {
            lastSnapshotHourRef.current = hourKey;
            try { sessionStorage.setItem(`lastSnapshotHour_${tournamentId}`, hourKey); } catch { /* ignore */ }
            const DAYS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const h     = hourLoc % 12 || 12;
            const ampm  = hourLoc < 12 ? 'AM' : 'PM';
            const label = `${DAYS[dow]} ${h}${ampm}`;
            const snap: TrendSnapshot = {
              timestamp: now.getTime(),
              hour:      label,
              scores:    Object.fromEntries(scores.map(s => [s.userId, s.top3Score])),
            };
            saveTrendSnapshot(tournamentId, snap).catch(() => {});
            setTrendSnapshots(prev => {
              const deduped = prev.filter(s => s.hour !== label);
              return [...deduped, snap].sort((a, b) => a.timestamp - b.timestamp);
            });

            // Also regenerate live odds alongside each hourly snapshot.
            // Always force:true — the 25-min cache is for manual refreshes only;
            // the scheduled hourly auto-gen should always produce fresh odds.
            if (hourKey !== lastOddsHourRef.current) {
              lastOddsHourRef.current = hourKey;
              try { sessionStorage.setItem(`lastOddsHour_${tournamentId}`, hourKey); } catch { /* ignore */ }
              fetch('/api/ai/live-odds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tournamentId, force: true }),
              }).then(r => r.ok ? r.json() : null)
                .then(d => {
                  if (d?.odds?.length > 0) {
                    setLiveOdds(d as LiveOdds);
                    // Reload snapshots so the Odds Trend graph picks up the new point
                    getOddsSnapshots(tournamentId).then(s => { if (s.length > 0) setOddsSnapshots(s); }).catch(() => {});
                  }
                })
                .catch(() => {});
            }
          }
        }

      } catch (e) {
        consecutiveFailures.current++;
        console.error('Leaderboard refresh error:', e);
        if (hasScoresRef.current) {
          setIsStale(true);
          setFetchError(null);
        } else {
          setFetchError('Network error. Retrying automatically.');
        }
      } finally {
        setRefreshing(false);
      }
    },
    [tournamentId, prevRoundPositions]
  );

  // Confetti when user is rank 1 (once per session)
  useEffect(() => {
    if (confettiFiredRef.current) return;
    const myTeamLocal = teamScores.find(t => t.userId === appUser?.uid);
    if (!myTeamLocal || myTeamLocal.rank !== 1 || !hasScoresRef.current) return;
    confettiFiredRef.current = true;
    confetti({ particleCount: 120, spread: 80, origin: { y: 0.55 },
      colors: ['#C9A227', '#D4AF37', '#006BB6', '#34d399', '#ffffff'] });
  }, [teamScores, appUser]);

  useEffect(() => {
    if (!tournament || users.length === 0) return;
    const t = tournament;
    refreshScores(t, users);
    function scheduleNext() {
      const interval = consecutiveFailures.current >= MAX_FAILURES_BEFORE_BACKOFF
        ? REFRESH_INTERVAL_BACKOFF_MS : REFRESH_INTERVAL_NORMAL_MS;
      intervalRef.current = setTimeout(() => refreshScores(t, users).then(scheduleNext), interval);
    }
    scheduleNext();
    return () => { if (intervalRef.current) clearTimeout(intervalRef.current); };
  }, [tournament, users, refreshScores]);

  if (loading || !appUser) {
    return (
      <div className="min-h-screen page"><Navigation />
        <main className="max-w-2xl mx-auto px-4 py-6 space-y-3">
          <div className="skeleton h-8 w-48 mb-4" />
          <div className="skeleton h-20 w-full rounded-xl" />
          {[1,2,3,4].map(i => <div key={i} className="skeleton h-16 w-full rounded-xl" />)}
        </main>
      </div>
    );
  }

  const hasLiveScores = teamScores.length > 0 && teamScores.some(t => t.players.some(p => p.points < 9000));
  const cutLine = derivedCutLine;
  const myTeam  = teamScores.find(t => t.userId === appUser.uid);

  // Pre-tournament: sort board by each team's earliest player tee time so users
  // can see who tees off first. Once live scores exist, revert to score ranking.
  const displayedTeams = useMemo(() => {
    if (hasLiveScores || Object.keys(fieldPlayers).length === 0) return teamScores;
    return [...teamScores].sort((a, b) => {
      const earliestMs = (team: TeamScore): number => {
        const times = team.players
          .map(p => fieldPlayers[p.playerId]?.teeTime)
          .filter((t): t is string => !!t)
          .map(t => new Date(t).getTime())
          .filter(t => !isNaN(t));
        return times.length > 0 ? Math.min(...times) : Infinity;
      };
      return earliestMs(a) - earliestMs(b);
    });
  }, [teamScores, hasLiveScores, fieldPlayers]);

  return (
    <div className="min-h-screen page">
      <Navigation />

      {/* Tournament ambient audio */}
      {theme.musicUrl && (
        <TournamentAudio
          trackUrl={theme.musicUrl}
          label={`${theme.label} Theme`}
          accent={theme.accent}
          accentMid={theme.accentMid}
        />
      )}

      <main className="max-w-2xl mx-auto px-4 py-6">

        {/* Tournament hero banner */}
        <TournamentHero
          theme={theme}
          year={tournament?.year ?? new Date().getFullYear()}
          subtitle={[
            tournament?.startDate,
            lastUpdated ? (secAgo < 8 ? 'Just updated' : `Updated ${secAgo < 60 ? `${secAgo}s` : `${Math.floor(secAgo/60)}m`} ago`) : null,
          ].filter(Boolean).join(' · ')}
          rightSlot={
            <button
              onClick={() => tournament && users.length > 0 && refreshScores(tournament, users, true)}
              disabled={refreshing}
              className="p-2 rounded-lg transition-colors"
              style={{ background: 'rgba(255,255,255,0.08)', color: refreshing ? theme.accentMid : '#64748b' }}
              title="Force refresh scores">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            </button>
          }
        />

        {/* Tab row — scrollable */}
        <div className="overflow-x-auto scrollbar-hide mb-4">
          <div className="flex gap-1 min-w-max p-1 rounded-xl" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
            {([['simple','Board',<List size={11}/>], ['detailed','Detail',<BarChart2 size={11}/>], ['trend','Trend',<TrendingUp size={11}/>], ['movers','Movers',<Activity size={11}/>], ['field','Field',<Globe size={11}/>], ['rosters','Rosters',<Users size={11}/>], ['odds','Odds',<Percent size={11}/>]] as const).map(([v, label, icon]) => (
              <button key={v} onClick={() => setView(v as any)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-all whitespace-nowrap rounded-lg"
                style={view === v
                  ? { background: theme.activeBg, color: theme.activeText, border: `1px solid ${theme.activeBorder}` }
                  : { color: '#475569', background: 'transparent', border: '1px solid transparent' }
                }>
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Status banners */}
        {isStale && !fetchError && (
          <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
            style={{ background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.18)', color: '#ca8a04' }}>
            <AlertTriangle size={11} />
            Showing last known scores
            {lastGoodUpdateRef.current && (
              <span style={{ color: '#a16207' }}>
                · last updated {lastGoodUpdateRef.current.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        )}
        {fetchError && (
          <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
            style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)', color: '#f87171' }}>
            <WifiOff size={11} /> {fetchError}
          </div>
        )}

        {/* My position callout */}
        {hasLiveScores && myTeam && (
          <div className="callout-my-team mb-5 flex items-center justify-between"
            style={{ borderColor: theme.cardBorder, boxShadow: theme.cardGlow }}>
            <div>
              <div className="text-xs text-slate-500 mb-0.5 uppercase tracking-wider">Your position</div>
              <div className="font-bebas text-4xl tracking-wider leading-none" style={{ color: theme.accentMid }}>
                {myTeam.rank}{['st','nd','rd'][myTeam.rank-1] ?? 'th'} place
              </div>
              {liveOdds && (() => {
                const myO = liveOdds.odds.find(o => o.userId === appUser.uid);
                const trendIcon = myO?.trend === 'up' ? ' ▲' : myO?.trend === 'down' ? ' ▼' : '';
                const trendColor = myO?.trend === 'up' ? '#34d399' : myO?.trend === 'down' ? '#f87171' : '#C9A227';
                return myO ? (
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-sm font-bold" style={{ color: trendColor }}>
                      {myO.winPct}% to win
                    </span>
                    <span className="text-xs font-bold" style={{ color: trendColor }}>{trendIcon}</span>
                  </div>
                ) : null;
              })()}
            </div>
            <div className="text-right">
              <div className="font-mono font-bold text-3xl" style={{ color: ptsColor(myTeam.top3Score) }}>
                {fmtPts(myTeam.top3Score)}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">team pts</div>
            </div>
          </div>
        )}

        {/* Empty state */}
        {teamScores.length === 0 && (
          <div className="text-center py-16 rounded-xl"
            style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
            <div className="text-4xl mb-3">⛳</div>
            <div className="font-bebas text-xl tracking-wider text-slate-400 mb-1">
              {tournament?.espnEventId ? 'Awaiting tee-off' : 'Not yet configured'}
            </div>
            <div className="text-xs text-slate-600 max-w-xs mx-auto leading-relaxed">
              {tournament?.espnEventId
                ? `Scores update automatically once ${tournament.shortName ?? 'the tournament'} begins. Check back Thursday.`
                : 'ESPN Event ID not set — Gibbs will configure this before the tournament starts.'}
            </div>
          </div>
        )}

        {/* BOARD view */}
        {view === 'simple' && teamScores.length > 0 && (
          <>
            {!hasLiveScores && Object.keys(fieldPlayers).length > 0 && (
              <div className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
                style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)', color: '#818cf8' }}>
                <span>⏱</span>
                Sorted by earliest tee time · will re-sort by score once play begins
              </div>
            )}
            <div className="space-y-1.5">
              {displayedTeams.map((team) => {
                const isMe  = team.userId === appUser.uid;
                const isExp = expandedTeam === team.userId;
                return (
                  <div key={team.userId}>
                    <ScoreRow
                      team={team} isMe={isMe} hasScores={hasLiveScores}
                      expanded={isExp} cutLine={cutLine}
                      winPct={liveOdds?.odds.find(o => o.userId === team.userId)?.winPct}
                      trend={liveOdds?.odds.find(o => o.userId === team.userId)?.trend}
                      flashClass={scoreFlashes[team.userId] === 'up' ? 'score-improved' : scoreFlashes[team.userId] === 'down' ? 'score-worsened' : undefined}
                      snapshots={trendSnapshots}
                      playersMap={fieldPlayers}
                      onToggle={() => setExpandedTeam(isExp ? null : team.userId)}
                    />
                    {isExp && <DetailPanel team={team} isMe={isMe} cutLine={cutLine} playersMap={fieldPlayers} />}
                  </div>
                );
              })}
            </div>
            <div className="mt-6 pt-4 text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1"
              style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <span>★ Best 3 count</span>
              <span>Top 10 bonus: −25 → −1</span>
              <span>Cut / WD / DQ = +{cutLine+1} pts</span>
              <span>Lower score = better rank</span>
            </div>
          </>
        )}

        {/* DETAIL view */}
        {view === 'detailed' && teamScores.length > 0 && (
          <>
            <div className="space-y-4">
              {teamScores.map((team) => (
                <React.Fragment key={team.userId}>
                  <DetailPanel team={team} isMe={team.userId === appUser.uid} cutLine={cutLine} standalone playersMap={fieldPlayers} />
                </React.Fragment>
              ))}
            </div>
            <div className="mt-6 pt-4 text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1"
              style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <span><span style={{ color: 'rgba(212,175,55,0.6)' }}>★</span> = counts toward score</span>
              <span>Top 10: −25, −15, −10, −8, −6, −5, −4, −3, −2, −1</span>
              <span>Pos 11+: points = position</span>
              <span>Cut/WD/DQ: +{cutLine+1} pts</span>
            </div>
          </>
        )}

        {/* FIELD view */}
        {view === 'field' && (
          <FieldLeaderboard
            players={fieldPlayers}
            draftedMap={draftedMap}
            cutLine={cutLine}
          />
        )}

        {/* MOVERS view */}
        {view === 'movers' && (
          <MoversPanel
            teams={teamScores}
            baseline={roundStartScores}
            myUserId={appUser.uid}
          />
        )}

        {/* TREND view */}
        {view === 'trend' && (
          <div className="space-y-3">
            <div className="rounded-xl overflow-hidden"
              style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="px-4 pt-4 pb-2">
                <div className="font-bebas text-lg tracking-wider text-white mb-0.5">Score Trend</div>
                <div className="text-xs text-slate-600">Hourly team scores Thu–Sun · lower is better</div>
              </div>
              <div className="px-3 pb-4">
                <TrendChart
                  snapshots={trendSnapshots}
                  teams={teamScores}
                  myUserId={appUser.uid}
                />
              </div>
            </div>

            {oddsSnapshots.length > 0 && (
              <div className="rounded-xl overflow-hidden"
                style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'rgba(255,255,255,0.02)' }}>
                <div className="px-4 pt-4 pb-2">
                  <div className="font-bebas text-lg tracking-wider text-white mb-0.5">Win Probability Trend</div>
                  <div className="text-xs text-slate-600">AI-generated win % over time · higher is better</div>
                </div>
                <div className="px-3 pb-4">
                  <OddsTrendChart
                    snapshots={oddsSnapshots}
                    teams={teamScores}
                    myUserId={appUser.uid}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* ROSTERS view */}
        {view === 'rosters' && (
          <RostersView teams={teamScores} myUserId={appUser.uid} playersMap={fieldPlayers} />
        )}

        {/* ODDS view */}
        {view === 'odds' && (
          <OddsPanel
            odds={liveOdds}
            myUserId={appUser.uid}
            teams={teamScores}
            loading={oddsLoading}
            isAdmin={appUser.role === 'admin'}
            onRefresh={() => {
              if (oddsLoading) return;
              setOddsLoading(true);
              fetch('/api/ai/live-odds', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tournamentId, force: true }),
              }).then(r => r.ok ? r.json() : null)
                .then(d => {
                  if (d?.odds?.length > 0) {
                    setLiveOdds(d as LiveOdds);
                    getOddsSnapshots(tournamentId).then(s => { if (s.length > 0) setOddsSnapshots(s); }).catch(() => {});
                  }
                })
                .catch(() => {})
                .finally(() => setOddsLoading(false));
            }}
          />
        )}

      </main>
    </div>
  );
}
