'use client';

import Link from 'next/link';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import {
  getTournament,
  subscribeDraftState,
  submitPick,
  getAllUsers,
  savePlayers,
  updateTournament,
} from '@/lib/db';
import { buildSnakeDraftOrder, getCurrentPicker } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import {
  buildEspnLookup,
  matchToEspnName,
  playerKey,
  type OddsPlayer,
} from '@/lib/odds';
import type { Tournament, DraftState, DraftPick, AppUser, Player } from '@/lib/types';
import { CheckCircle, User, TrendingUp, Wifi } from 'lucide-react';

const ESPN_REFRESH_MS = 30_000;
const ODDS_REFRESH_MS = 10 * 60 * 1000; // odds stable, refresh every 10 min

// ─── Unified player entry shown in draft room ────────────────────────────────

interface DraftPlayer {
  // Identity
  id: string;             // stable key (playerKey of best available name)
  displayName: string;    // name shown in UI
  espnId: string | null;  // ESPN athlete ID (for scoring lookup later)
  espnName: string | null;

  // Odds data
  oddsDisplay: string | null;   // "+1200"
  americanOdds: number | null;
  impliedProb: number | null;
  oddsSource: string | null;

  // ESPN live data (populated once tournament starts)
  position: number | null;
  positionDisplay: string;
  score: string;
  thru: string;
  status: Player['status'];

  // Source flag
  source: 'odds' | 'espn' | 'both';
}

type SortMode = 'odds' | 'position' | 'name';

export default function DraftRoomPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { appUser, loading } = useAuth();
  const router = useRouter();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);

  // Player data layers
  const [oddsPlayers, setOddsPlayers] = useState<OddsPlayer[]>([]);
  const [espnPlayers, setEspnPlayers] = useState<Record<string, Player>>({});
  const [mergedPlayers, setMergedPlayers] = useState<DraftPlayer[]>([]);
  const [oddsSource, setOddsSource] = useState<string>('');
  const [espnSource, setEspnSource] = useState<string>('');
  const [oddsStale, setOddsStale] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('odds');
  const [pickLoading, setPickLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  // Auth guard
  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  // Load tournament + users
  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [t, allUsers] = await Promise.all([getTournament(tournamentId), getAllUsers()]);
      setTournament(t);
      setUsers(allUsers);
    }
    load();
  }, [appUser, tournamentId]);

  // Subscribe to real-time draft state
  useEffect(() => {
    const unsub = subscribeDraftState(tournamentId, setDraftState);
    return unsub;
  }, [tournamentId]);

  // ─── Fetch odds ─────────────────────────────────────────────────────────────

  const fetchOdds = useCallback(async (bust = false) => {
    try {
      const res = await fetch(
        `/api/odds?tournament=${encodeURIComponent(tournamentId)}${bust ? '&bust=1' : ''}`
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data.players?.length > 0) {
        setOddsPlayers(data.players);
        setOddsSource(data.source ?? '');
        setOddsStale(!!data.stale);
      }
    } catch (e) {
      console.error('[DraftRoom] Odds fetch failed:', e);
    }
  }, [tournamentId]);

  // ─── Fetch ESPN field / leaderboard ─────────────────────────────────────────

  const fetchEspn = useCallback(async (espnEventId: string, bust = false) => {
    if (!espnEventId) return;
    try {
      const url = `/api/espn/leaderboard?eventId=${espnEventId}${bust ? '&bust=1' : ''}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const { players: parsed, fieldSize, cutLine } = parseLeaderboard(data);
      if (Object.keys(parsed).length > 0) {
        setEspnPlayers(parsed);
        setEspnSource(res.headers.get('X-Cache-Source') ?? 'ESPN');
        if (tournament && fieldSize > 0 && fieldSize !== tournament.fieldSize) {
          const maxPicks = fieldSize >= 100 ? 5 : 4;
          await updateTournament(tournamentId, { fieldSize, maxPicks, cutLine });
          setTournament((prev) => prev ? { ...prev, fieldSize, maxPicks, cutLine } : prev);
        }
        await savePlayers(tournamentId, parsed);
      }
    } catch (e) {
      console.error('[DraftRoom] ESPN fetch failed:', e);
    }
  }, [tournament, tournamentId]);

  // Polling
  useEffect(() => {
    fetchOdds();
    const i = setInterval(() => fetchOdds(), ODDS_REFRESH_MS);
    return () => clearInterval(i);
  }, [fetchOdds]);

  useEffect(() => {
    if (!tournament?.espnEventId) return;
    fetchEspn(tournament.espnEventId);
    const i = setInterval(() => fetchEspn(tournament.espnEventId), ESPN_REFRESH_MS);
    return () => clearInterval(i);
  }, [tournament?.espnEventId, fetchEspn]);

  // ─── Merge odds + ESPN into unified player list ─────────────────────────────

  useEffect(() => {
    const espnLookup = buildEspnLookup(Object.values(espnPlayers).map((p) => p.name));
    const merged = new Map<string, DraftPlayer>();

    // 1. Seed from odds (primary source for draft)
    for (const op of oddsPlayers) {
      const espnName = matchToEspnName(op.name, espnLookup);
      // Find ESPN player by matched name
      const espnEntry = espnName
        ? Object.values(espnPlayers).find((p) => p.name === espnName) ?? null
        : null;

      const key = op.id;
      merged.set(key, {
        id: key,
        displayName: op.name,
        espnId: espnEntry?.id ?? null,
        espnName,
        oddsDisplay: op.oddsDisplay,
        americanOdds: op.americanOdds,
        impliedProb: op.impliedProb,
        oddsSource: op.bookmaker,
        position: espnEntry?.position ?? null,
        positionDisplay: espnEntry?.positionDisplay ?? '-',
        score: espnEntry?.score ?? '-',
        thru: espnEntry?.thru ?? '-',
        status: espnEntry?.status ?? 'active',
        source: espnEntry ? 'both' : 'odds',
      });
    }

    // 2. Add ESPN-only players not in odds (e.g. late additions to field)
    for (const ep of Object.values(espnPlayers)) {
      const key = playerKey(ep.name);
      if (!merged.has(key)) {
        merged.set(key, {
          id: key,
          displayName: ep.name,
          espnId: ep.id,
          espnName: ep.name,
          oddsDisplay: null,
          americanOdds: null,
          impliedProb: null,
          oddsSource: null,
          position: ep.position,
          positionDisplay: ep.positionDisplay,
          score: ep.score,
          thru: ep.thru,
          status: ep.status,
          source: 'espn',
        });
      }
    }

    setMergedPlayers(Array.from(merged.values()));
  }, [oddsPlayers, espnPlayers]);

  // ─── Computed values ─────────────────────────────────────────────────────────

  if (!appUser || !tournament) {
    return (
      <div className="min-h-screen"><Navigation />
        <div className="flex items-center justify-center h-64 font-bebas text-xl tracking-widest animate-pulse" style={{color:"#C9A227"}}>LOADING draft room…</div>
      </div>
    );
  }

  const snakeOrder = draftState?.snakeDraftOrder ??
    buildSnakeDraftOrder(tournament.draftOrder, tournament.maxPicks * tournament.draftOrder.length);
  const currentPickerUid = draftState ? getCurrentPicker(snakeOrder, draftState.currentPickIndex) : null;
  const isMyTurn = currentPickerUid === appUser.uid;
  const draftComplete = draftState?.status === 'complete' || tournament.draftComplete;
  const usernameMap = Object.fromEntries(users.map((u) => [u.uid, u.username]));
  const currentPick = draftState?.currentPickIndex ?? 0;
  const currentRound = Math.floor(currentPick / Math.max(tournament.draftOrder.length, 1)) + 1;
  const currentPickerName = currentPickerUid ? usernameMap[currentPickerUid] : '—';
  const myPicks = (draftState?.picks ?? []).filter((p) => p.userId === appUser.uid);
  const pickedIds = new Set((draftState?.picks ?? []).map((p) => p.playerId));
  const hasEspnField = Object.keys(espnPlayers).length > 0;
  const hasOdds = oddsPlayers.length > 0;

  // Available players — not yet picked, filtered, sorted
  const available = mergedPlayers
    .filter((p) => {
      // Filter out picked players — check both id and espnId
      if (pickedIds.has(p.id) || (p.espnId && pickedIds.has(p.espnId))) return false;
      if (searchTerm === '') return true;
      return p.displayName.toLowerCase().includes(searchTerm.toLowerCase());
    })
    .sort((a, b) => {
      if (sortMode === 'odds') {
        const ap = a.impliedProb ?? -1;
        const bp = b.impliedProb ?? -1;
        if (ap !== bp) return bp - ap; // higher prob = favorite = first
        // odds-less players go to bottom
        if (ap === -1 && bp !== -1) return 1;
        if (bp === -1 && ap !== -1) return -1;
        return a.displayName.localeCompare(b.displayName);
      }
      if (sortMode === 'position') {
        const ap = a.position ?? 9999;
        const bp = b.position ?? 9999;
        return ap - bp;
      }
      return a.displayName.localeCompare(b.displayName);
    });

  // ─── Pick handler ────────────────────────────────────────────────────────────

  async function handlePick(player: DraftPlayer) {
    if (!isMyTurn || !draftState || pickLoading) return;
    setPickLoading(true);
    setStatusMsg('');
    try {
      // Use ESPN ID if we have it, otherwise use our stable key
      // This ensures scoring works later when ESPN field is available
      const pickId = player.espnId ?? player.id;
      const pickName = player.espnName ?? player.displayName;

      const pick: DraftPick = {
        userId: appUser!.uid,
        username: appUser!.username,
        playerId: pickId,
        playerName: pickName,
        pickNumber: draftState.currentPickIndex + 1,
        round: currentRound,
        timestamp: Date.now(),
      };

      const nextIndex = draftState.currentPickIndex + 1;
      const isDraftComplete = nextIndex >= snakeOrder.length;
      await submitPick(tournamentId, pick, nextIndex, isDraftComplete);
      setStatusMsg(`✅ Picked ${pickName}`);
    } catch {
      setStatusMsg('❌ Pick failed — try again.');
    } finally {
      setPickLoading(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen">
      <Navigation />
      <main className="max-w-6xl mx-auto px-4 py-6">

        {/* Header */}
        <div className="mb-4">
          <h1 className="font-bebas text-3xl tracking-wider text-white">{tournament.name}</h1>
          <div className="flex flex-wrap items-center gap-3 mt-1">
            <p className="text-slate-400 text-sm">
              Snake Draft · {tournament.maxPicks} picks/team
              {tournament.fieldSize > 0 ? ` · ${tournament.fieldSize} player field` : ''}
            </p>
            {/* Data source pills */}
            {hasOdds && (
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-900/50 border border-green-800 text-green-300">
                <TrendingUp size={10} />
                {oddsSource} odds
                {oddsStale && ' (cached)'}
              </span>
            )}
            {hasEspnField && (
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-900/50 border border-blue-800 text-blue-300">
                <Wifi size={10} />
                {espnSource} field
              </span>
            )}
            {!hasOdds && !hasEspnField && (
              <span className="text-xs text-yellow-500 animate-pulse">Loading player data…</span>
            )}
          </div>
        </div>

        {/* Status banner */}
        {draftComplete ? (
          <div className="card-royal mb-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <CheckCircle className="text-green-400 shrink-0" size={20} />
              <div>
                <p className="font-semibold text-white">Draft Complete!</p>
                <p className="text-slate-400 text-sm">All picks locked in. Check the leaderboard once the tournament begins.</p>
              </div>
            </div>
            <Link href={`/wd/${tournamentId}`}
              className="btn-gold text-sm py-1.5 px-3 shrink-0">
              ⚠ WD Replacement
            </Link>
          </div>
        ) : draftState?.status === 'open' ? (
          <div className={`card mb-4 flex items-center gap-3 border ${
            isMyTurn ? '' : ''
          }`}>
            <User size={20} className={isMyTurn ? 'text-yellow-400' : 'text-slate-400'} />
            <div className="flex-1">
              {isMyTurn ? (
                <p className="font-bold text-yellow-300">🎯 It's your turn to pick! — Round {currentRound}, Pick #{currentPick + 1}</p>
              ) : (
                <p className="font-semibold text-white">
                  Waiting for <span className="text-green-400">{currentPickerName}</span>
                  <span className="text-slate-400 font-normal"> — Round {currentRound}, Pick #{currentPick + 1}</span>
                </p>
              )}
            </div>
            {statusMsg && <p className="text-sm shrink-0">{statusMsg}</p>}
          </div>
        ) : (
          <div className="card mb-4 text-slate-400 text-sm">
            Draft not yet open. Gibbs will start it when ready.
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Left column: my team + full draft board */}
          <div className="space-y-4">

            {/* My roster */}
            <div className="card">
              <h2 className="font-bebas text-lg tracking-wider text-white mb-3">
                My Team
                <span className="text-slate-400 font-normal text-sm ml-2">
                  ({myPicks.length}/{tournament.maxPicks})
                </span>
              </h2>
              {myPicks.length === 0 ? (
                <p className="text-slate-500 text-sm italic">No picks yet</p>
              ) : (
                <ul className="space-y-1.5">
                  {myPicks.map((pick, i) => {
                    const merged = mergedPlayers.find(
                      (p) => p.espnId === pick.playerId || p.id === pick.playerId
                    );
                    return (
                      <li key={pick.playerId} className="flex items-center gap-2 text-sm">
                        <span className="text-slate-500 w-4 shrink-0">{i + 1}.</span>
                        <span className="text-white flex-1">{pick.playerName}</span>
                        {merged?.oddsDisplay && (
                          <span className="text-xs text-slate-500 font-mono">{merged.oddsDisplay}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Full snake draft board */}
            <div className="card">
              <h2 className="font-bebas text-lg tracking-wider text-white mb-3">Draft Board</h2>
              <div className="space-y-0.5 max-h-80 overflow-y-auto pr-1">
                {snakeOrder.map((uid, i) => {
                  const pick = draftState?.picks?.[i];
                  const isCurrent = !draftComplete && i === currentPick;
                  return (
                    <div key={`${uid}-${i}`}
                      className={`flex items-center gap-2 text-xs px-2 py-1 rounded transition-colors ${
                        isCurrent ? 'bg-yellow-800/50 border border-yellow-700' : pick ? 'opacity-40' : ''
                      }`}>
                      <span className="text-slate-600 w-5 text-right shrink-0">{i + 1}.</span>
                      <span className={`font-medium truncate flex-1 ${uid === appUser.uid ? 'text-green-400' : 'text-slate-300'}`}>
                        {usernameMap[uid] ?? uid}
                      </span>
                      {pick && <span className="text-slate-500 truncate max-w-[80px]">{pick.playerName.split(' ').pop()}</span>}
                      {isCurrent && <span className="text-yellow-400 shrink-0">←</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: available players */}
          <div className="lg:col-span-2">
            <div className="card">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h2 className="font-bold text-white">
                  Available Players
                  <span className="text-slate-500 font-normal text-sm ml-2">({available.length})</span>
                </h2>

                {/* Sort tabs */}
                <div className="flex gap-1 text-xs">
                  {([
                    ['odds', '📊 Odds'],
                    ...(hasEspnField ? [['position', '🏌️ Position']] : []),
                    ['name', '🔤 A–Z'],
                  ] as [SortMode, string][]).map(([mode, label]) => (
                    <button key={mode} onClick={() => setSortMode(mode)}
                      className={`px-2 py-1 rounded transition-colors ${
                        sortMode === mode ? 'bg-green-700 text-white' : 'bg-slate-700 text-slate-400 hover:text-white'
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Search */}
              <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search players…"
                className="input mb-3" />

              {/* Name match warning if ESPN field not yet loaded */}
              {hasOdds && !hasEspnField && (
                <div className="mb-3 text-xs text-yellow-600/80 bg-yellow-900/20 border border-yellow-800/40 rounded-lg px-3 py-2">
                  ⚠ ESPN field not yet available — picks will be matched to ESPN names automatically once the field is confirmed. Odds-based names are displayed for now.
                </div>
              )}

              {/* Empty state */}
              {!hasOdds && !hasEspnField ? (
                <div className="text-center py-12 text-slate-500">
                  <p className="text-2xl mb-2">⛳</p>
                  <p className="font-medium text-slate-400">Loading player data…</p>
                  <p className="text-xs mt-1">
                    {tournament.espnEventId
                      ? 'Fetching from ESPN + betting odds sources'
                      : 'Fetching betting odds — set ESPN Event ID in Admin when available'}
                  </p>
                </div>
              ) : (
                <div className="overflow-y-auto max-h-[30rem] pr-1">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-800 z-10">
                      <tr className="text-slate-400 text-xs border-b border-slate-700">
                        <th className="text-left py-2 pr-2 w-6">#</th>
                        <th className="text-left py-2">Player</th>
                        <th className="text-right py-2 w-16">Odds</th>
                        {hasEspnField && <>
                          <th className="text-right py-2 w-12">Pos</th>
                          <th className="text-right py-2 w-10 hidden sm:table-cell">Thru</th>
                        </>}
                        {isMyTurn && !draftComplete && <th className="w-14"></th>}
                      </tr>
                    </thead>
                    <tbody>
                      {available.map((player, idx) => (
                        <tr key={player.id}
                          className="border-b border-slate-700/40 hover:bg-slate-700/30 transition-colors">
                          <td className="py-2 pr-2 text-slate-600 text-xs">{idx + 1}</td>
                          <td className="py-2">
                            <div className="font-medium text-white leading-tight">{player.displayName}</div>
                            {/* Show match status indicator */}
                            {player.source === 'both' && (
                              <div className="text-xs text-green-600/70">✓ ESPN matched</div>
                            )}
                            {player.source === 'odds' && hasEspnField && (
                              <div className="text-xs text-yellow-600/70">⚠ no ESPN match yet</div>
                            )}
                          </td>
                          <td className="py-2 text-right">
                            {player.oddsDisplay ? (
                              <div>
                                <span className={`font-mono text-sm font-semibold ${
                                  player.americanOdds !== null && player.americanOdds < 0
                                    ? 'text-green-400'
                                    : player.americanOdds !== null && player.americanOdds <= 500
                                    ? 'text-yellow-300'
                                    : 'text-slate-300'
                                }`}>
                                  {player.oddsDisplay}
                                </span>
                                {player.impliedProb !== null && (
                                  <div className="text-xs text-slate-500">
                                    {player.impliedProb.toFixed(1)}%
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-600 text-xs">—</span>
                            )}
                          </td>
                          {hasEspnField && <>
                            <td className="py-2 text-right text-xs text-slate-400">
                              {player.status === 'cut' ? (
                                <span className="text-orange-400">CUT</span>
                              ) : player.positionDisplay !== '-' ? (
                                player.positionDisplay
                              ) : '—'}
                            </td>
                            <td className="py-2 text-right text-xs text-slate-500 hidden sm:table-cell">
                              {player.thru !== '-' ? player.thru : '—'}
                            </td>
                          </>}
                          {isMyTurn && !draftComplete && (
                            <td className="py-2 pl-2">
                              <button onClick={() => handlePick(player)} disabled={pickLoading}
                                className="btn-primary text-xs py-1 px-2 w-full">
                                Pick
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Source footer */}
              {(hasOdds || hasEspnField) && (
                <p className="text-xs text-slate-600 mt-2 text-right">
                  {[hasOdds && `Odds: ${oddsSource}`, hasEspnField && `Field: ${espnSource}`]
                    .filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
