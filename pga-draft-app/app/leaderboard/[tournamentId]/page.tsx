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
} from '@/lib/db';
import { calculateLeaderboard } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import type { Tournament, TeamScore, AppUser, Player } from '@/lib/types';
import { RefreshCw, Wifi, WifiOff, AlertTriangle, BarChart2, List } from 'lucide-react';

const REFRESH_INTERVAL_NORMAL_MS = 60_000;
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
  team, isMe, hasScores, expanded, onToggle,
}: {
  team: TeamScore; isMe: boolean; hasScores: boolean; expanded: boolean; onToggle: () => void;
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
          {/* top 3 player preview */}
          {hasScores && top3.length > 0 ? (
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {top3.map((p, i) => (
                <span key={p.playerId} className="text-xs flex items-center gap-1">
                  <span className="font-bold" style={{ color: ptsColor(p.points) }}>
                    {p.positionDisplay !== '-' ? p.positionDisplay : '—'}
                  </span>
                  {/* tiny position change indicator in board view */}
                  {p.positionChange !== null && p.currentRound > 1 && (
                    <span style={{
                      color: p.positionChange > 0 ? '#34d399' : p.positionChange < 0 ? '#f87171' : '#64748b',
                      fontSize: '9px',
                    }}>
                      {p.positionChange > 0 ? '▲' : p.positionChange < 0 ? '▼' : ''}
                    </span>
                  )}
                  <span className="text-slate-500">{p.playerName.split(' ').pop()}</span>
                  {i < top3.length - 1 && <span className="text-slate-700">·</span>}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-xs text-slate-600">{hasScores ? 'No scores yet' : 'Awaiting tee-off'}</span>
          )}
        </div>

        {/* Team score */}
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

// ─── Expanded detail panel ────────────────────────────────────────────────────

function DetailPanel({ team, isMe, cutLine }: { team: TeamScore; isMe: boolean; cutLine: number }) {
  const sorted = [...team.players].sort((a, b) => a.points - b.points);
  const hasAnyLiveScore = sorted.some(p => p.points < 9000);

  return (
    <div style={{
      background: 'rgba(0,0,0,0.25)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderTop: 'none',
      borderRadius: '0 0 12px 12px',
      overflow: 'hidden',
    }}>
      {/* Player list */}
      {sorted.map((p, idx) => {
        const isCounting = p.countsInTop3;
        const pending = p.points >= 9000;
        const posColor = pending ? '#475569'
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
            {/* Counting bar */}
            <div className="w-1 h-8 rounded-full shrink-0" style={{ background: isCounting ? '#D4AF37' : 'rgba(255,255,255,0.08)' }} />

            {/* Name + status */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-sm font-medium text-white">{p.playerName}</span>
                <StatusPill status={p.status} />
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

            {/* Thru */}
            {!pending && (
              <div className="text-right shrink-0 w-8">
                <div className="text-xs text-slate-500">{p.thru !== '-' ? p.thru : '—'}</div>
                <div className="text-xs text-slate-700">thru</div>
              </div>
            )}

            {/* Position + change arrow */}
            <div className="text-right shrink-0 w-16">
              <div className="flex items-center justify-end gap-1">
                <div className="text-sm font-bold" style={{ color: posColor }}>
                  {pending ? '—'
                    : p.status === 'cut' ? 'CUT'
                    : p.status === 'wd' ? 'WD'
                    : p.status === 'dq' ? 'DQ'
                    : p.positionDisplay || '—'}
                </div>
                {/* Position change arrow — only show in round 2+ when we have data */}
                {!pending && p.positionChange !== null && p.currentRound > 1 && (
                  <span className="text-xs font-bold" style={{
                    color: p.positionChange > 0 ? '#34d399'   // green = moved up
                         : p.positionChange < 0 ? '#f87171'   // red = moved down
                         : '#64748b',                          // grey = same
                  }}>
                    {p.positionChange > 0 ? `▲${p.positionChange}`
                   : p.positionChange < 0 ? `▼${Math.abs(p.positionChange)}`
                   : '—'}
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-600">pos</div>
            </div>

            {/* Points */}
            <div className="text-right shrink-0 w-10">
              <div className="text-sm font-bold font-mono" style={{ color: ptsColor(p.points) }}>
                {fmtPts(p.points)}
              </div>
              <div className="text-xs text-slate-600">pts</div>
            </div>
          </div>
        );
      })}

      {/* Panel footer */}
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

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LeaderboardPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { appUser, loading } = useAuth();
  const router = useRouter();

  const [tournament, setTournament]   = useState<Tournament | null>(null);
  const [teamScores, setTeamScores]   = useState<TeamScore[]>([]);
  const [users, setUsers]             = useState<AppUser[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [view, setView]               = useState<'simple' | 'detailed'>('simple');
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);
  const [dataSource, setDataSource]   = useState('');
  const [isStale, setIsStale]         = useState(false);
  const [fetchError, setFetchError]   = useState<string | null>(null);
  const consecutiveFailures = useRef(0);
  const intervalRef         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasScoresRef        = useRef(false);
  const lastGoodUpdateRef   = useRef<Date | null>(null);
  const [prevRoundPositions, setPrevRoundPositions] = useState<Record<string, number | null> | null>(null);
  const detectedRoundRef    = useRef(1); // track highest round we've seen so far

  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [t, allUsers] = await Promise.all([getTournament(tournamentId), getAllUsers()]);
      setTournament(t);
      setUsers(allUsers);
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
          // Keep existing scores — just mark stale with the last good time
          if (hasScoresRef.current) {
            setIsStale(true);
            setFetchError(null); // don't show error if we have data to show
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
            // We have good data already — stay stale, keep showing last scores
            setIsStale(true);
            setFetchError(null);
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

        // Merged ID + name keys for fallback scoring
        const mergedMap: Record<string, Player> = { ...parsed };
        for (const player of Object.values(parsed)) {
          const nameKey = player.name
            .toLowerCase().normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '').replace(/\./g, '')
            .replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
          mergedMap[nameKey] = player;
        }

        // ── Round-change detection: auto-save R1 positions when R2 starts ──
        // Look at all parsed players — find the highest current round number
        const allPlayers = Object.values(parsed);
        const maxRound = allPlayers.reduce((m, p) => Math.max(m, p.currentRound ?? 1), 1);

        let currentPrevPositions = prevRoundPositions;

        if (maxRound > detectedRoundRef.current) {
          // A new round has started — save end-of-previous-round positions to Firebase
          const prevRound = maxRound - 1;
          const snapshot: Record<string, number | null> = {};
          for (const [id, player] of Object.entries(parsed)) {
            snapshot[id] = player.position;
          }
          await saveRoundPositionSnapshot(tournamentId, prevRound, snapshot);
          detectedRoundRef.current = maxRound;
          setPrevRoundPositions(snapshot);
          currentPrevPositions = snapshot;
        } else if (maxRound > 1 && currentPrevPositions === null) {
          // Round 2+ but we don't have the snapshot in memory yet — fetch from Firebase
          const snap = await getRoundPositionSnapshot(tournamentId, maxRound - 1);
          if (snap) {
            setPrevRoundPositions(snap);
            currentPrevPositions = snap;
          }
        }

        const scores = calculateLeaderboard(userPicksMap, mergedMap, cutLine ?? t.cutLine ?? 65, currentPrevPositions);
        setTeamScores(scores);
        hasScoresRef.current = true;
        const now = new Date();
        setLastUpdated(now);
        lastGoodUpdateRef.current = now;
        if (cacheAge && parseInt(cacheAge, 10) > 180) setIsStale(true);
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
    [tournamentId]
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

        {/* ── Header ── */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h1 className="font-bebas text-3xl tracking-wider text-white leading-none">
              {tournament?.shortName ?? tournament?.name ?? 'Leaderboard'}
            </h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap text-xs text-slate-500">
              <span>{tournament?.startDate}</span>
              {lastUpdated && <span>· {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
              {dataSource && !fetchError && (
                <span className="flex items-center gap-1"><Wifi size={9} className="text-green-500" />live</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* View toggle */}
            <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.09)' }}>
              {(['simple', 'detailed'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all"
                  style={{
                    background: view === v ? 'rgba(212,175,55,0.18)' : 'transparent',
                    color: view === v ? '#D4AF37' : '#64748b',
                    borderLeft: v === 'detailed' ? '1px solid rgba(255,255,255,0.09)' : 'none',
                  }}>
                  {v === 'simple' ? <><List size={11} /> Board</> : <><BarChart2 size={11} /> Detail</>}
                </button>
              ))}
            </div>
            <button onClick={() => tournament && users.length > 0 && refreshScores(tournament, users, true)}
              disabled={refreshing}
              className="p-2 rounded-lg transition-colors"
              style={{ background: 'rgba(255,255,255,0.05)', color: refreshing ? '#D4AF37' : '#475569' }}>
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Status banners */}
        {isStale && !fetchError && (
          <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(234,179,8,0.07)', border: '1px solid rgba(234,179,8,0.18)', color: '#ca8a04' }}>
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
          <div className="mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)', color: '#f87171' }}>
            <WifiOff size={11} /> {fetchError}
          </div>
        )}

        {/* Draft grades panel */}
        {/* ── My position callout ── */}
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

        {/* ── Empty state ── */}
        {teamScores.length === 0 && (
          <div className="text-center py-16 rounded-xl" style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}>
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

        {/* ── SIMPLE BOARD view ── */}
        {view === 'simple' && teamScores.length > 0 && (
          <>
            <div className="space-y-1.5">
              {teamScores.map((team) => {
                const isMe = team.userId === appUser.uid;
                const isExp = expandedTeam === team.userId;
                return (
                  <div key={team.userId}>
                    <ScoreRow
                      team={team} isMe={isMe} hasScores={hasLiveScores}
                      expanded={isExp}
                      onToggle={() => setExpandedTeam(isExp ? null : team.userId)}
                    />
                    {isExp && <DetailPanel team={team} isMe={isMe} cutLine={cutLine} />}
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div className="mt-6 pt-4 text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1"
              style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <span>★ Best 3 count</span>
              <span>Top 10 bonus: −25 → −1</span>
              <span>Cut / WD / DQ = +{cutLine+1} pts</span>
              <span>Lower score = better rank</span>
            </div>
          </>
        )}

        {/* ── DETAILED view ── */}
        {view === 'detailed' && teamScores.length > 0 && (
          <>
            <div className="space-y-4">
              {teamScores.map((team) => (
                <DetailPanel key={team.userId} team={team} isMe={team.userId === appUser.uid} cutLine={cutLine} />
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

      </main>
    </div>
  );
}
