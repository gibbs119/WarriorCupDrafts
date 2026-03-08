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
} from '@/lib/db';
import { calculateLeaderboard } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import type { Tournament, TeamScore, AppUser } from '@/lib/types';
import { RefreshCw, TrendingDown, Wifi, WifiOff, AlertTriangle } from 'lucide-react';

// Poll every 60s during tournament, but back off to 90s after 3 consecutive failures
const REFRESH_INTERVAL_NORMAL_MS = 60_000;
const REFRESH_INTERVAL_BACKOFF_MS = 90_000;
const MAX_FAILURES_BEFORE_BACKOFF = 3;

export default function LeaderboardPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { appUser, loading } = useAuth();
  const router = useRouter();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [teamScores, setTeamScores] = useState<TeamScore[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);

  // Data source health tracking
  const [dataSource, setDataSource] = useState<string>('');
  const [isStale, setIsStale] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const consecutiveFailures = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasScoresRef = useRef(false); // avoids stale closure in refreshScores

  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [t, allUsers] = await Promise.all([
        getTournament(tournamentId),
        getAllUsers(),
      ]);
      setTournament(t);
      setUsers(allUsers);
    }
    load();
  }, [appUser, tournamentId]);

  // ─── Resilient score refresh ────────────────────────────────────────────────

  const refreshScores = useCallback(
    async (t: Tournament, allUsers: AppUser[], isBust = false) => {
      if (!t.espnEventId) return;
      setRefreshing(true);
      setFetchError(null);

      try {
        const url = `/api/espn/leaderboard?eventId=${t.espnEventId}${isBust ? '&bust=1' : ''}`;
        const res = await fetch(url);

        // Read response headers for source transparency
        const cacheStatus = res.headers.get('X-Cache') ?? '';
        const source = res.headers.get('X-Cache-Source') ?? '';
        const cacheAge = res.headers.get('X-Cache-Age');

        if (!res.ok) {
          consecutiveFailures.current++;
          const body = await res.json().catch(() => ({}));
          setFetchError(
            body.error ?? `Data unavailable (attempt ${consecutiveFailures.current}). Will retry automatically.`
          );
          // If we previously had scores, keep showing them with a stale warning
          setIsStale(teamScores.length > 0);
          return;
        }

        const data = await res.json();
        const { players: parsed, cutLine } = parseLeaderboard(data);

        if (Object.keys(parsed).length === 0) {
          consecutiveFailures.current++;
          setFetchError('Received empty player data. Scores may not be available yet.');
          setIsStale(hasScoresRef.current);
          return;
        }

        // Success — reset failure counter
        consecutiveFailures.current = 0;
        setIsStale(cacheStatus === 'STALE');
        setDataSource(source);
        setFetchError(null);

        // Save to Firebase so all users see same data
        await savePlayers(tournamentId, parsed);

        // Build team scores
        const draftState = await getDraftState(tournamentId);
        if (!draftState) return;

        const userPicksMap: Record<string, { username: string; picks: typeof draftState.picks }> = {};
        for (const user of allUsers) {
          const picks = draftState.picks.filter((p) => p.userId === user.uid);
          if (picks.length > 0) userPicksMap[user.uid] = { username: user.username, picks };
        }

        const scores = calculateLeaderboard(userPicksMap, parsed, cutLine ?? t.cutLine ?? 65);
        setTeamScores(scores);
        hasScoresRef.current = true;
        setLastUpdated(new Date());

        // Show stale warning if ESPN served cached data older than 3 minutes
        if (cacheAge && parseInt(cacheAge, 10) > 180) {
          setIsStale(true);
        }
      } catch (e) {
        consecutiveFailures.current++;
        console.error('Leaderboard refresh error:', e);
        setFetchError('Network error fetching scores. Will retry automatically.');
        setIsStale(teamScores.length > 0);
      } finally {
        setRefreshing(false);
      }
    },
    [tournamentId]
  );

  // ─── Adaptive polling interval ──────────────────────────────────────────────

  useEffect(() => {
    if (!tournament || users.length === 0) return;
    const t = tournament; // non-null reference safe to use in callbacks

    // Initial fetch
    refreshScores(t, users);

    function scheduleNext() {
      const interval =
        consecutiveFailures.current >= MAX_FAILURES_BEFORE_BACKOFF
          ? REFRESH_INTERVAL_BACKOFF_MS
          : REFRESH_INTERVAL_NORMAL_MS;

      intervalRef.current = setTimeout(() => {
        refreshScores(t, users).then(scheduleNext);
      }, interval);
    }

    scheduleNext();
    return () => {
      if (intervalRef.current) clearTimeout(intervalRef.current);
    };
  }, [tournament, users, refreshScores]);

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (loading || !appUser) {
    return (
      <div className="min-h-screen">
        <Navigation />
        <div className="flex items-center justify-center h-64 font-bebas text-xl tracking-widest animate-pulse" style={{color:"#C9A227"}}>LOADING…</div>
      </div>
    );
  }

  const rankEmoji = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `${rank}.`;
  };

  return (
    <div className="min-h-screen">
      <Navigation />
      <main className="max-w-4xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="font-bebas text-3xl tracking-wider text-white">{tournament?.name ?? 'Tournament'}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="text-slate-400 text-sm">
                {tournament?.status === 'completed' ? 'Final Results' : 'Live Leaderboard'}
              </p>
              {lastUpdated && (
                <span className="text-slate-500 text-xs">
                  · Updated {lastUpdated.toLocaleTimeString()}
                </span>
              )}
              {/* Data source pill */}
              {dataSource && !fetchError && (
                <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">
                  <Wifi size={10} className="text-green-400" />
                  {dataSource}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => tournament && users.length > 0 && refreshScores(tournament, users, true)}
            disabled={refreshing}
            className="btn-secondary flex items-center gap-2 text-sm shrink-0"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {/* Stale data warning */}
        {isStale && !fetchError && (
          <div className="mb-4 flex items-center gap-2 bg-yellow-900/30 border border-yellow-700 rounded-lg px-4 py-2 text-sm text-yellow-300">
            <AlertTriangle size={14} />
            Showing last known good scores — live data temporarily unavailable. Auto-retrying.
          </div>
        )}

        {/* Fetch error banner */}
        {fetchError && (
          <div className="mb-4 flex items-center gap-2 bg-red-900/30 border border-red-800 rounded-lg px-4 py-2 text-sm text-red-300">
            <WifiOff size={14} />
            {fetchError}
            {consecutiveFailures.current >= MAX_FAILURES_BEFORE_BACKOFF && (
              <span className="ml-1 text-red-400/70">(polling slowed to every 90s)</span>
            )}
          </div>
        )}

        {/* Scoring note */}
        <p className="text-xs mb-4" style={{color:"rgba(148,163,184,0.5)"}}>
          ★ Only each team's best 3 players count. Lower score = better rank. Tiebreaker: best individual position.
        </p>

        {/* Team leaderboard */}
        {teamScores.length === 0 ? (
          <div className="card text-center py-12 text-slate-400">
            {tournament?.espnEventId
              ? refreshing
                ? 'Fetching scores from ESPN…'
                : fetchError
                ? 'Scores unavailable. Will retry automatically.'
                : 'No scores yet — tournament may not have started.'
              : 'ESPN Event ID not configured yet. Contact Gibbs.'}
          </div>
        ) : (
          <div className="space-y-3">
            {teamScores.map((team) => {
              const isExpanded = expandedTeam === team.userId;
              const isMe = team.userId === appUser.uid;

              return (
                <div
                  key={team.userId}
                  className={`card cursor-pointer transition-all hover:border-white/15 ${
                    isMe ? '' : ''
                  }`}
                  onClick={() => setExpandedTeam(isExpanded ? null : team.userId)}
                >
                  {/* Summary row */}
                  <div className="flex items-center gap-4">
                    <span className="text-xl w-8 text-center shrink-0">{rankEmoji(team.rank)}</span>
                    <span className={`font-bold text-base flex-1 ${isMe ? '' : ''}`} style={isMe ? {color:'#C9A227'} : {}}>
                      {team.username}
                      {isMe && <span className="text-xs text-slate-400 ml-2">(you)</span>}
                    </span>

                    {/* Top 3 player quick-view */}
                    <div className="hidden sm:flex gap-3">
                      {team.players
                        .filter((p) => p.countsInTop3)
                        .sort((a, b) => a.points - b.points)
                        .map((p) => (
                          <span key={p.playerId} className="text-xs text-slate-400 flex items-center gap-1">
                            <span className="font-medium text-slate-300">{p.positionDisplay}</span>
                            <span className="text-slate-600">{p.playerName.split(' ').pop()}</span>
                          </span>
                        ))}
                    </div>

                    <div className="text-right shrink-0">
                      <div className={`text-xl font-bold font-mono ${
                        team.top3Score < 0 ? 'text-red-400' : 'text-slate-200'
                      }`}>
                        {team.top3Score > 0 ? '+' : ''}{team.top3Score}
                      </div>
                      <div className="text-xs text-slate-500">top 3 pts</div>
                    </div>
                    <span className="text-slate-600 text-sm">{isExpanded ? '▲' : '▼'}</span>
                  </div>

                  {/* Expanded player breakdown */}
                  {isExpanded && (
                    <div className="mt-4 border-t border-slate-700 pt-4">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-slate-500 border-b border-slate-700">
                            <th className="text-left py-1">Player</th>
                            <th className="text-right py-1">Pos</th>
                            <th className="text-right py-1">Score</th>
                            <th className="text-right py-1">Thru</th>
                            <th className="text-right py-1">Pts</th>
                            <th className="text-center py-1 w-16">Counts</th>
                          </tr>
                        </thead>
                        <tbody>
                          {team.players
                            .slice()
                            .sort((a, b) => a.points - b.points)
                            .map((p) => (
                              <tr
                                key={p.playerId}
                                className={`border-b border-slate-700/40 ${
                                  !p.countsInTop3 ? 'opacity-40' : ''
                                }`}
                              >
                                <td className="py-1.5 text-white">{p.playerName}</td>
                                <td className={`py-1.5 text-right text-xs font-medium ${
                                  p.status === 'cut' ? 'text-orange-400' :
                                  p.status === 'wd'  ? 'text-slate-500' :
                                  'text-slate-300'
                                }`}>
                                  {p.status === 'cut' ? 'CUT' : p.status === 'wd' ? 'WD' : p.positionDisplay}
                                </td>
                                <td className="py-1.5 text-right font-mono text-xs text-slate-400">—</td>
                                <td className="py-1.5 text-right text-slate-400 text-xs">{p.thru}</td>
                                <td className={`py-1.5 text-right font-bold font-mono text-sm ${
                                  p.points < 0 ? 'text-red-400' :
                                  p.points >= 9000 ? 'text-slate-600' : 'text-slate-300'
                                }`}>
                                  {p.points >= 9000 ? '—' : (p.points > 0 ? `+${p.points}` : p.points)}
                                </td>
                                <td className="py-1.5 text-center">
                                  {p.countsInTop3
                                    ? <span className="text-green-400 text-xs font-bold">✓</span>
                                    : <span className="text-slate-700 text-xs">—</span>}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                        <TrendingDown size={12} />
                        Top 3 lowest-scoring players count.
                        {team.players.some((p) => p.status === 'cut') && (
                          <span className="ml-1 text-orange-400/80">
                            Cut players score cut line + 1 pts.
                          </span>
                        )}
                      </p>
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
