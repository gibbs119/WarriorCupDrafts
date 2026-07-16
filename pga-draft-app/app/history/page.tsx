'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import { get, ref } from 'firebase/database';
import { db } from '@/lib/firebase';
import { Trophy, Lock, ChevronDown, ChevronRight, Users, Calendar, TrendingUp, RefreshCw, Radio } from 'lucide-react';
import { TOURNAMENTS } from '@/lib/constants';
import { parseLeaderboard } from '@/lib/espn';
import { calculateLeaderboard } from '@/lib/scoring';
import { getDraftState } from '@/lib/db';

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

// ─── 2026 season column definitions ──────────────────────────────────────────

const SEASON_COLS = [
  { id: 'players-championship', label: 'Players' },
  { id: 'masters',              label: 'Masters'  },
  { id: 'pga-championship',    label: 'PGA'       },
  { id: 'us-open',             label: 'US Open'   },
  { id: 'the-open',            label: 'The Open', live: true },
] as const;

const OPEN_CONFIG = TOURNAMENTS.find(t => t.id === 'the-open')!;

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

// ─── Season Trend Chart ───────────────────────────────────────────────────────

function SeasonChart({ rows, liveIdx }: { rows: SeasonRow[]; liveIdx: number }) {
  const W = 500, H = 180, PAD = { t: 12, r: 16, b: 48, l: 36 };
  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  const n  = SEASON_COLS.length;

  // Collect all real scores (exclude DNS sentinel)
  const allScores = rows.flatMap(r => r.scores).filter((s): s is number => s !== null && s < 9000);
  if (allScores.length === 0) return null;

  const minS = Math.min(...allScores);
  const maxS = Math.max(...allScores);
  const range = Math.max(maxS - minS, 10);
  const padded = range * 0.15;

  // Lower score = better = higher on chart (inverted Y)
  const scY = (s: number) => {
    const t = (s - (minS - padded)) / (range + 2 * padded);
    return PAD.t + t * cH; // low score → low t → high y (inverted below)
  };
  // Invert: best score at top
  const toY = (s: number) => PAD.t + cH - (scY(s) - PAD.t);
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
      {SEASON_COLS.map((col, ci) => (
        <line key={col.id}
          x1={toX(ci)} y1={PAD.t} x2={toX(ci)} y2={PAD.t + cH}
          stroke="rgba(255,255,255,0.04)" strokeWidth="1"
        />
      ))}

      {/* Lines + dots per user */}
      {rows.map((row, ri) => {
        const color = SEASON_COLORS[ri % SEASON_COLORS.length];
        const pts = row.scores
          .map((s, ci) => (s !== null && s < 9000 ? { x: toX(ci), y: toY(s), ci } : null))
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
      {SEASON_COLS.map((col, ci) => (
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

  // Season-standings state
  const [season2026, setSeason2026] = useState<SeasonRow[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const liveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { if (!loading && !appUser) router.push('/'); }, [loading, appUser, router]);

  // ── Load locked scores + historical picks ─────────────────────────────────
  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [lockedSnap, histSnap] = await Promise.all([
        get(ref(db, 'lockedScores')),
        get(ref(db, 'historicalDrafts')),
      ]);
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

      // ── Build 2026 season from locked data ─────────────────────────────────
      const lockedByTournId: Record<string, LockedTournament> = {};
      for (const lt of Object.values(locked)) {
        if ((lt.year ?? new Date(lt.lockedAt).getFullYear()) === 2026) {
          lockedByTournId[lt.tournamentId] = lt;
        }
      }

      // Collect all usernames that appear in any 2026 locked tournament
      const allUsernames = new Set<string>();
      for (const lt of Object.values(lockedByTournId)) {
        for (const ts of lt.teamScores ?? []) allUsernames.add(ts.username);
      }

      // Build per-user per-tournament scores (only locked ones — live score added separately)
      const rowMap: Record<string, { username: string; scores: (number | null)[] }> = {};
      for (const username of allUsernames) {
        rowMap[username] = { username, scores: SEASON_COLS.map(() => null) };
        SEASON_COLS.forEach((col, ci) => {
          if (col.live) return; // filled by live fetch below
          const lt = lockedByTournId[col.id];
          if (!lt) return;
          const ts = lt.teamScores?.find(t => t.username === username);
          if (ts) rowMap[username].scores[ci] = ts.top3Score;
        });
      }

      // Store incomplete rows (live slot = null); refreshLive will fill it
      setSeason2026(buildRankedRows(rowMap));
      setFetching(false);

      // Kick off live fetch immediately
      fetchLiveOpen(rowMap);
    }
    load().catch(() => setFetching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUser]);

  // ── Live refresh interval ─────────────────────────────────────────────────
  useEffect(() => {
    liveTimer.current = setInterval(() => {
      setSeason2026(prev => {
        // Rebuild the rowMap from existing state to pass to fetchLiveOpen
        const rowMap: Record<string, { username: string; scores: (number | null)[] }> = {};
        for (const row of prev) {
          rowMap[row.username] = { username: row.username, scores: [...row.scores] };
        }
        fetchLiveOpen(rowMap);
        return prev; // state update happens inside fetchLiveOpen
      });
    }, 60_000);
    return () => { if (liveTimer.current) clearInterval(liveTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch live Open scores and merge ─────────────────────────────────────
  async function fetchLiveOpen(rowMap: Record<string, { username: string; scores: (number | null)[] }>) {
    const liveColIdx = SEASON_COLS.findIndex(c => c.live);
    if (liveColIdx < 0) return;

    const now = Date.now();
    const liveStart = OPEN_CONFIG.liveScoresStart ? new Date(OPEN_CONFIG.liveScoresStart).getTime() : 0;
    if (liveStart > 0 && now < liveStart) {
      // Tournament not started — no live scores
      setSeason2026(buildRankedRows(rowMap));
      return;
    }

    setLiveLoading(true);
    try {
      const [espnRes, draftState] = await Promise.all([
        fetch(`/api/espn/leaderboard?eventId=${OPEN_CONFIG.espnEventId}`),
        getDraftState('the-open'),
      ]);
      if (!espnRes.ok || !draftState) return;

      const espnData = await espnRes.json();
      const { players } = parseLeaderboard(espnData);

      // Build userPicksMap from draft state
      const userPicksMap: Record<string, { username: string; picks: import('@/lib/types').DraftPick[] }> = {};
      for (const pick of draftState.picks) {
        userPicksMap[pick.userId] ??= { username: pick.username, picks: [] };
        userPicksMap[pick.userId].picks.push(pick);
        // ensure this user exists in rowMap
        if (!rowMap[pick.username]) {
          rowMap[pick.username] = { username: pick.username, scores: SEASON_COLS.map(() => null) };
        }
      }

      const liveTeams = calculateLeaderboard(userPicksMap, players, OPEN_CONFIG.cutLine);

      // Merge live scores into rowMap
      const merged = { ...rowMap };
      for (const team of liveTeams) {
        if (!merged[team.username]) {
          merged[team.username] = { username: team.username, scores: SEASON_COLS.map(() => null) };
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

  const liveColIdx = SEASON_COLS.findIndex(c => c.live);
  const hasLiveScores = season2026.some(r => r.scores[liveColIdx] !== null);

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

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-8 space-y-8">

        {/* ── 2026 Season Standings ── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs uppercase tracking-widest font-semibold mb-0.5" style={{color:'rgba(148,163,184,0.5)'}}>Current Year</p>
              <h2 className="font-bebas text-3xl tracking-widest text-white flex items-center gap-2">
                <TrendingUp size={24} style={{color:'#E8C94A'}} /> 2026 Season Standings
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
                  fetchLiveOpen(rowMap);
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
                      {SEASON_COLS.map((col, ci) => (
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
                  <TrendingUp size={15} style={{color:'#E8C94A'}} /> Tournament-by-Tournament Scores
                  <span className="text-xs font-sans font-normal ml-1" style={{color:'rgba(148,163,184,0.4)'}}>lower = better</span>
                </h3>
                <SeasonChart rows={season2026} liveIdx={liveColIdx} />
                <ChartLegend rows={season2026} appUsername={appUser.username} />
              </div>
            </div>
          )}
        </section>

        {/* ── All-Time Section ── */}
        <section>
          <div className="mb-6">
            <p className="text-xs uppercase tracking-widest font-semibold mb-1" style={{color:'rgba(148,163,184,0.5)'}}>All-Time Records</p>
            <h1 className="font-bebas text-4xl tracking-widest text-white flex items-center gap-3">
              <Trophy size={32} style={{color:'#C9A227'}} /> Season History
            </h1>
            <p className="text-sm mt-1" style={{color:'rgba(148,163,184,0.4)'}}>
              2019–present · Picks from historical spreadsheet · Scores auto-locked every Monday at 8 pm ET
            </p>
          </div>

          {fetching ? (
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
          )}
        </section>

      </main>
    </div>
  );
}
