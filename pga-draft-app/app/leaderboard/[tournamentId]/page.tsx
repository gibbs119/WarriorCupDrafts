'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import {
  getTournament,
  getDraftState,
  getAllUsers,
  savePlayers,
  saveRoundPositionSnapshot,
  getRoundPositionSnapshot,
  saveTrendSnapshot,
  getTrendSnapshots,
  type TrendSnapshot,
} from '@/lib/db';
import { calculateLeaderboard } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import type { Tournament, TeamScore, AppUser, Player } from '@/lib/types';
import { RefreshCw, Wifi, WifiOff, AlertTriangle, BarChart2, List, TrendingUp, Activity, Globe } from 'lucide-react';

const REFRESH_INTERVAL_NORMAL_MS  = 60_000;
const REFRESH_INTERVAL_BACKOFF_MS = 90_000;
const MAX_FAILURES_BEFORE_BACKOFF = 3;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Simple scoreboard row ────────────────────────────────────────────────────

function ScoreRow({
  team, isMe, hasScores, expanded, onToggle, cutLine,
}: {
  team: TeamScore; isMe: boolean; hasScores: boolean; expanded: boolean; onToggle: () => void; cutLine: number;
}) {
  const top3 = team.players.filter(p => p.countsInTop3).sort((a, b) => a.points - b.points);

  return (
    <div
      onClick={onToggle}
      className="cursor-pointer select-none transition-all duration-150"
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
            <span className="text-xs text-slate-600">{hasScores ? 'No scores yet' : 'Awaiting tee-off'}</span>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono font-bold text-2xl" style={{ color: ptsColor(hasScores ? team.top3Score : 9999) }}>
            {hasScores ? fmtPts(team.top3Score) : '—'}
          </div>
          <div className="text-xs text-slate-600">pts</div>
        </div>
        <div className="text-slate-600 text-xs ml-1">{expanded ? '▲' : '▼'}</div>
      </div>
    </div>
  );
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ team, isMe, cutLine, standalone }: {
  team: TeamScore; isMe: boolean; cutLine: number; standalone?: boolean;
}) {
  const sorted = [...team.players].sort((a, b) => a.points - b.points);
  const hasAnyLiveScore = sorted.some(p => p.points < 9000);

  return (
    <div style={{
      background: standalone ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.25)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderTop: standalone ? '1px solid rgba(255,255,255,0.07)' : 'none',
      borderRadius: standalone ? '12px' : '0 0 12px 12px',
      overflow: 'hidden',
    }}>
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
          {hasAnyLiveScore && (
            <span className="font-mono font-bold text-xl" style={{ color: ptsColor(team.top3Score) }}>
              {fmtPts(team.top3Score)}
            </span>
          )}
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
                {pending ? 'Not yet started'
                  : p.status === 'cut' ? `Cut line — scores ${cutLine + 1} pts`
                  : p.status === 'wd' || p.status === 'dq' ? `${p.status.toUpperCase()} — scores ${cutLine + 1} pts`
                  : p.thru === 'F' ? 'Round complete'
                  : p.thru !== '-' ? `Thru hole ${p.thru}`
                  : 'Tee time pending'}
              </div>
            </div>
            {!pending && (
              <div className="text-right shrink-0 w-8">
                <div className="text-xs text-slate-500">{p.thru !== '-' ? p.thru : '—'}</div>
                <div className="text-xs text-slate-700">thru</div>
              </div>
            )}

            {/* Score to par — visual only */}
            {!pending && (
              <div className="text-right shrink-0 w-10">
                <div className="text-sm font-bold font-mono" style={{
                  color: p.score === 'E' ? '#64748b'
                       : p.score.startsWith('-') ? '#f87171'
                       : p.score === '—' ? '#475569'
                       : '#cbd5e1',
                }}>
                  {p.score}
                </div>
                <div className="text-xs text-slate-700">golf</div>
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
                {!pending && p.positionChange !== null && p.currentRound > 1 && (
                  <span className="text-xs font-bold" style={{
                    color: p.positionChange > 0 ? '#34d399' : p.positionChange < 0 ? '#f87171' : '#64748b',
                  }}>
                    {p.positionChange > 0 ? `▲${p.positionChange}`
                   : p.positionChange < 0 ? `▼${Math.abs(p.positionChange)}`
                   : '—'}
                  </span>
                )}
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
        {hasAnyLiveScore && (
          <span className="text-xs font-mono font-bold" style={{ color: ptsColor(team.top3Score) }}>
            {fmtPts(team.top3Score)} team
          </span>
        )}
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
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' as React.CSSProperties['WebkitOverflowScrolling'], borderRadius: 8 }}>
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
            <div className="text-center font-mono font-bold text-sm" style={{ color: team.top3Score < 0 ? '#34d399' : '#cbd5e1' }}>
              {team.top3Score === 0 ? 'E' : team.top3Score > 0 ? `+${team.top3Score}` : `${team.top3Score}`}
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

  // Sort by position, put null/WD/DQ last
  const sorted = unique.sort((a, b) => {
    if (a.status === 'wd' || a.status === 'dq') return 1;
    if (b.status === 'wd' || b.status === 'dq') return -1;
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position - b.position;
  });

  const active = sorted.filter(p => p.status !== 'cut' && p.status !== 'wd' && p.status !== 'dq');
  const cut    = sorted.filter(p => p.status === 'cut' || p.status === 'wd' || p.status === 'dq');

  const normName = (n: string) =>
    n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\./g,'').replace(/[-\u2013]/g,' ').replace(/\s+/g,' ').trim();

  function PlayerRow({ p, idx, total }: { p: Player; idx: number; total: number }) {
    const owner = draftedMap[normName(p.name)];
    const isDrafted = !!owner;
    const scoreColor = !p.score || p.score === '—' || p.score === '-' ? '#475569'
      : p.score === 'E' ? '#64748b'
      : p.score.startsWith('-') ? '#34d399'
      : '#f87171';
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

        {/* Name + owner tag */}
        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
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

        {/* Thru */}
        <div className="text-xs shrink-0 w-7 text-right" style={{ color: '#475569' }}>
          {isCut || isWdDq ? '—' : (p.thru !== '-' ? p.thru : '—')}
        </div>

        {/* Score */}
        <div className="text-sm font-bold font-mono shrink-0 w-9 text-right" style={{ color: scoreColor }}>
          {isCut || isWdDq ? '—' : (p.score || '—')}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden" style={{
      border: '1px solid rgba(255,255,255,0.07)',
      background: 'rgba(255,255,255,0.02)',
    }}>
      {/* Column headers */}
      <div className="flex items-center px-3 py-2 gap-2 text-xs font-medium"
        style={{ color: '#475569', borderBottom: '1px solid rgba(255,255,255,0.07)', background: 'rgba(0,0,0,0.2)' }}>
        <div className="w-9 text-right shrink-0">Pos</div>
        <div className="flex-1">Player</div>
        <div className="w-7 text-right shrink-0">Thru</div>
        <div className="w-9 text-right shrink-0">Score</div>
      </div>

      {/* Active players */}
      {active.map((p, i) => (
        <PlayerRow key={p.id} p={p} idx={i} total={active.length} />
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
            <PlayerRow key={p.id} p={p} idx={i} total={cut.length} />
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LeaderboardPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { appUser, loading } = useAuth();
  const router = useRouter();

  const [tournament,         setTournament]         = useState<Tournament | null>(null);
  const [teamScores,         setTeamScores]         = useState<TeamScore[]>([]);
  const [users,              setUsers]              = useState<AppUser[]>([]);
  const [lastUpdated,        setLastUpdated]        = useState<Date | null>(null);
  const [refreshing,         setRefreshing]         = useState(false);
  const [view,               setView]               = useState<'simple' | 'detailed' | 'trend' | 'movers' | 'field'>('simple');
  const [roundStartScores,   setRoundStartScores]   = useState<Record<string, { score: number; rank: number }> | null>(null);
  const [fieldPlayers,       setFieldPlayers]       = useState<Record<string, Player>>({});
  const [draftedMap,         setDraftedMap]         = useState<Record<string, string>>({});  // playerName.lower → username
  const [trendSnapshots,     setTrendSnapshots]     = useState<TrendSnapshot[]>([]);
  const [expandedTeam,       setExpandedTeam]       = useState<string | null>(null);
  const [dataSource,         setDataSource]         = useState('');
  const [isStale,            setIsStale]            = useState(false);
  const [fetchError,         setFetchError]         = useState<string | null>(null);
  const [prevRoundPositions, setPrevRoundPositions] = useState<Record<string, number | null> | null>(null);

  const consecutiveFailures = useRef(0);
  const intervalRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasScoresRef        = useRef(false);
  const lastGoodUpdateRef   = useRef<Date | null>(null);
  const lastSnapshotHourRef = useRef<string>('');
  const detectedRoundRef    = useRef(1);

  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [t, allUsers, snaps] = await Promise.all([
        getTournament(tournamentId),
        getAllUsers(),
        getTrendSnapshots(tournamentId),
      ]);
      setTournament(t);
      setUsers(allUsers);
      if (snaps.length > 0) setTrendSnapshots(snaps);
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
        const { players: parsed, cutLine } = parseLeaderboard(data);

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
          const posSnap: Record<string, number | null> = {};
          for (const [id, player] of Object.entries(parsed)) posSnap[id] = player.position;
          await saveRoundPositionSnapshot(tournamentId, prevRound, posSnap);
          detectedRoundRef.current = maxRound;
          setPrevRoundPositions(posSnap);
          currentPrevPositions = posSnap;
        } else if (maxRound > 1 && currentPrevPositions === null) {
          const fetched = await getRoundPositionSnapshot(tournamentId, maxRound - 1);
          if (fetched) { setPrevRoundPositions(fetched); currentPrevPositions = fetched; }
        }

        const scores = calculateLeaderboard(userPicksMap, mergedMap, cutLine ?? t.cutLine ?? 65, currentPrevPositions);
        setTeamScores(scores);
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
        // Capture round-start baseline the first time we get real scores
        setRoundStartScores(prev => {
          if (prev !== null) return prev;
          const baseline: Record<string, { score: number; rank: number }> = {};
          scores.forEach(t => { baseline[t.userId] = { score: t.top3Score, rank: t.rank }; });
          return baseline;
        });
        hasScoresRef.current = true;
        const now = new Date();
        setLastUpdated(now);
        lastGoodUpdateRef.current = now;
        if (cacheAge && parseInt(cacheAge, 10) > 180) setIsStale(true);

        // ── Hourly trend snapshot ──────────────────────────────────────────
        // EDT = UTC-4. Record one snapshot per hour, Thu–Sun 8 AM–8 PM ET,
        // only when at least one team has a real score (not the 9999 sentinel).
        const nowET  = new Date(now.getTime() - 4 * 60 * 60 * 1000);
        const dow    = nowET.getUTCDay();    // 0=Sun 4=Thu 5=Fri 6=Sat
        const hourET = nowET.getUTCHours();

        const isTourDay  = dow === 4 || dow === 5 || dow === 6 || dow === 0;
        const isTourHour = hourET >= 8 && hourET <= 20;

        if (isTourDay && isTourHour && scores.some(s => s.top3Score < 9000)) {
          // Key is ISO-hour string e.g. "2026-03-12T14" — one snapshot per hour
          const hourKey = nowET.toISOString().slice(0, 13);
          if (hourKey !== lastSnapshotHourRef.current) {
            lastSnapshotHourRef.current = hourKey;
            const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const h      = hourET % 12 || 12;
            const ampm   = hourET < 12 ? 'AM' : 'PM';
            const label  = `${DAYS[dow]} ${h}${ampm}`;
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
        <div className="flex items-center justify-center h-64 font-bebas text-xl tracking-widest animate-pulse" style={{ color: '#C9A227' }}>LOADING…</div>
      </div>
    );
  }

  const hasLiveScores = teamScores.length > 0 && teamScores.some(t => t.players.some(p => p.points < 9000));
  const cutLine = tournament?.cutLine ?? 65;
  const myTeam  = teamScores.find(t => t.userId === appUser.uid);

  return (
    <div className="min-h-screen page">
      <Navigation />
      <main className="max-w-2xl mx-auto px-4 py-6">

        {/* Header — stacked layout for mobile/landscape */}
        <div className="mb-4">
          {/* Title row */}
          <div className="flex items-start justify-between mb-3">
            <div className="min-w-0 mr-2">
              <h1 className="font-bebas text-2xl tracking-wider text-white leading-none truncate">
                {tournament?.shortName ?? tournament?.name ?? 'Leaderboard'}
              </h1>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs text-slate-500">
                <span>{tournament?.startDate}</span>
                {lastUpdated && <span>· {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                {dataSource && !fetchError && (
                  <span className="flex items-center gap-1"><Wifi size={9} className="text-green-500" />live</span>
                )}
              </div>
            </div>
            <button
              onClick={() => tournament && users.length > 0 && refreshScores(tournament, users, true)}
              disabled={refreshing}
              className="p-2 rounded-lg shrink-0 transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: refreshing ? '#D4AF37' : '#475569' }}>
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
          {/* Tab row — scrollable so it never wraps or clips on narrow screens */}
          <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
            <div className="flex rounded-lg min-w-max" style={{ border: '1px solid rgba(255,255,255,0.09)' }}>
              {([['simple','Board',<List size={11}/>], ['detailed','Detail',<BarChart2 size={11}/>], ['trend','Trend',<TrendingUp size={11}/>], ['movers','Movers',<Activity size={11}/>], ['field','Field',<Globe size={11}/>]] as const).map(([v, label, icon]) => (
                <button key={v} onClick={() => setView(v as any)}
                  className="flex items-center gap-1 px-3 py-2 text-xs font-medium transition-all whitespace-nowrap flex-1"
                  style={{
                    background:  view === v ? 'rgba(212,175,55,0.18)' : 'transparent',
                    color:       view === v ? '#D4AF37' : '#64748b',
                    borderLeft:  v !== 'simple' ? '1px solid rgba(255,255,255,0.09)' : 'none',
                    minWidth: '56px',
                    justifyContent: 'center',
                  }}>
                  {icon}
                  {label}
                </button>
              ))}
            </div>
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
          <div className="mb-5 rounded-xl px-5 py-4 flex items-center justify-between"
            style={{ background: 'linear-gradient(135deg,rgba(27,58,158,0.35),rgba(13,31,92,0.55))', border: '1px solid rgba(212,175,55,0.2)' }}>
            <div>
              <div className="text-xs text-slate-500 mb-0.5 uppercase tracking-wider">Your position</div>
              <div className="font-bebas text-4xl tracking-wider leading-none" style={{ color: '#D4AF37' }}>
                {myTeam.rank}{['st','nd','rd'][myTeam.rank-1] ?? 'th'} place
              </div>
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
            <div className="space-y-1.5">
              {teamScores.map((team) => {
                const isMe  = team.userId === appUser.uid;
                const isExp = expandedTeam === team.userId;
                return (
                  <div key={team.userId}>
                    <ScoreRow
                      team={team} isMe={isMe} hasScores={hasLiveScores}
                      expanded={isExp} cutLine={cutLine}
                      onToggle={() => setExpandedTeam(isExp ? null : team.userId)}
                    />
                    {isExp && <DetailPanel team={team} isMe={isMe} cutLine={cutLine} />}
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
                <DetailPanel key={team.userId} team={team} isMe={team.userId === appUser.uid} cutLine={cutLine} standalone />
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
        )}

      </main>
    </div>
  );
}
