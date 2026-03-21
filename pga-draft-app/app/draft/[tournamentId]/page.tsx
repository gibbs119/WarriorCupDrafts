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
import { STATIC_FIELDS } from '@/lib/constants';
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

  // Top 10 finish odds
  top10Display: string | null;
  top10AmericanOdds: number | null;
  top10ImpliedProb: number | null;

  // ESPN live data (populated once tournament starts)
  position: number | null;
  positionDisplay: string;
  score: string;
  thru: string;
  status: Player['status'];
  worldRanking: number | null;  // Official World Golf Ranking

  // Source flag
  source: 'odds' | 'espn' | 'both';
}

type SortMode = 'odds' | 'top10' | 'rank' | 'position' | 'name';

// Play a short chime using Web Audio API — no audio file needed
function playChime() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.18);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.4);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.45);
    });
  } catch {}
}

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
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [pickLoading, setPickLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [myTurnAlert, setMyTurnAlert] = useState(false);   // in-tab banner
  const prevPickerUidRef = useRef<string | null>(null);     // track picker changes
  const snakeOrderRef = useRef<string[]>([]);                  // always-current snake order

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

    // Try leaderboard first (has scores), fall back to field endpoint (pre-tournament)
    const urls = [
      `/api/espn/leaderboard?eventId=${espnEventId}${bust ? '&bust=1' : ''}`,
      `/api/espn/field?eventId=${espnEventId}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const { players: parsed, fieldSize, cutLine } = parseLeaderboard(data);
        if (Object.keys(parsed).length > 0) {
          setEspnPlayers(parsed);
          setEspnSource(url.includes('leaderboard') ? 'ESPN Leaderboard' : 'ESPN Field');
          if (tournament && fieldSize > 0 && fieldSize !== tournament.fieldSize) {
            const maxPicks = fieldSize >= 100 ? 5 : 4;
            await updateTournament(tournamentId, { fieldSize, maxPicks, cutLine });
            setTournament((prev) => prev ? { ...prev, fieldSize, maxPicks, cutLine } : prev);
          }
          await savePlayers(tournamentId, parsed);
          return; // success — stop trying
        }
      } catch (e) {
        console.warn('[DraftRoom] ESPN fetch attempt failed:', url, e);
      }
    }
    console.error('[DraftRoom] All ESPN fetch attempts failed for eventId:', espnEventId);
  }, [tournament, tournamentId]);

  // Immediately seed player list from static field so draft room is never empty.
  // APIs will overwrite this with real odds/ESPN data as they load.
  useEffect(() => {
    const staticPlayers = STATIC_FIELDS[tournamentId];
    if (!staticPlayers || staticPlayers.length === 0) return;
    // Only seed if we don't already have real data
    setMergedPlayers((prev) => {
      if (prev.length > 0) return prev;
      return staticPlayers.map((name) => ({
        id: playerKey(name),
        displayName: name,
        espnId: null,
        espnName: name,
        oddsDisplay: null,
        americanOdds: null,
        impliedProb: null,
        oddsSource: null,
        top10Display: null,
        top10AmericanOdds: null,
        top10ImpliedProb: null,
        position: null,
        positionDisplay: '-',
        score: '-',
        thru: '-',
        status: 'active' as const,
        worldRanking: null,
        source: 'odds' as const,
      }));
    });
  }, [tournamentId]);

  // ── In-tab alert + push trigger when it becomes your turn ────────────────
  useEffect(() => {
    const order = snakeOrderRef.current;
    if (!draftState || !appUser || order.length === 0) return;
    const currentUid = getCurrentPicker(order, draftState.currentPickIndex);
    const prevUid = prevPickerUidRef.current;

    // Only fire when picker actually changes (not on first load)
    if (prevUid !== null && currentUid !== prevUid) {
      if (currentUid === appUser.uid) {
        // ── It's MY turn ──
        setMyTurnAlert(true);
        // Play a chime using Web Audio API (no file needed)
        playChime();
        // Page title flash
        try { document.title = "⛳ YOUR PICK! — PGA Draft"; setTimeout(() => { document.title = "PGA Draft League"; }, 8000); } catch {}
      } else {
        setMyTurnAlert(false);
      }
    }

    prevPickerUidRef.current = currentUid;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftState?.currentPickIndex]);

  // Polling — ESPN field loads FIRST (ensures ESPN IDs are ready for picks)
  // This is critical: if ESPN loads before odds, picks get saved with ESPN numeric IDs
  // which guarantees scoring works correctly during the tournament.
  useEffect(() => {
    if (!tournament?.espnEventId) return;
    fetchEspn(tournament.espnEventId); // immediate
    const i = setInterval(() => fetchEspn(tournament.espnEventId), ESPN_REFRESH_MS);
    return () => clearInterval(i);
  }, [tournament?.espnEventId, fetchEspn]);

  useEffect(() => {
    // Slight delay so ESPN has a chance to load first
    const t = setTimeout(() => fetchOdds(), 500);
    const i = setInterval(() => fetchOdds(), ODDS_REFRESH_MS);
    return () => { clearTimeout(t); clearInterval(i); };
  }, [fetchOdds]);

  // ─── Merge odds + ESPN into unified player list ─────────────────────────────

  useEffect(() => {
    const espnLookup = buildEspnLookup((Object.values(espnPlayers) as Player[]).map((p) => p.name));
    const merged = new Map<string, DraftPlayer>();

    // 1. Seed from odds (primary source for draft)
    for (const op of oddsPlayers) {
      const espnName = matchToEspnName(op.name, espnLookup);
      // Find ESPN player by matched name
      const espnEntry = espnName
        ? (Object.values(espnPlayers) as Player[]).find((p) => p.name === espnName) ?? null
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
        top10Display: op.top10Display ?? null,
        top10AmericanOdds: op.top10AmericanOdds ?? null,
        top10ImpliedProb: op.top10ImpliedProb ?? null,
        position: espnEntry?.position ?? null,
        positionDisplay: espnEntry?.positionDisplay ?? '-',
        score: espnEntry?.score ?? '-',
        thru: espnEntry?.thru ?? '-',
        status: espnEntry?.status ?? 'active',
        worldRanking: espnEntry?.worldRanking ?? null,
        source: espnEntry ? 'both' : 'odds',
      });
    }

    // 2. Add ESPN-only players not in odds (e.g. late additions to field)
    for (const ep of Object.values(espnPlayers) as Player[]) {
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
          top10Display: null,
          top10AmericanOdds: null,
          top10ImpliedProb: null,
          position: ep.position,
          positionDisplay: ep.positionDisplay,
          score: ep.score,
          thru: ep.thru,
          status: ep.status,
          worldRanking: ep.worldRanking ?? null,
          source: 'espn',
        });
      }
    }

    setMergedPlayers(Array.from(merged.values()));
  }, [oddsPlayers, espnPlayers]);

  // ─── Computed values ─────────────────────────────────────────────────────────

  if (!appUser || !tournament) {
    return (
      <div className="min-h-screen page"><Navigation />
        <div className="flex items-center justify-center h-64 font-bebas text-xl tracking-widest animate-pulse" style={{color:"#C9A227"}}>LOADING draft room…</div>
      </div>
    );
  }

  // Show a clear warning if player pool is empty (API issues)
  const playerPoolEmpty = mergedPlayers.length === 0;

  const snakeOrder = draftState?.snakeDraftOrder ??
    buildSnakeDraftOrder(tournament.draftOrder, tournament.maxPicks * tournament.draftOrder.length);
  // Keep ref in sync so the useEffect always has the latest value without stale closure
  snakeOrderRef.current = snakeOrder;
  const currentPickerUid = draftState ? getCurrentPicker(snakeOrder, draftState.currentPickIndex) : null;
  const isMyTurn = currentPickerUid === appUser.uid;
  const draftComplete = draftState?.status === 'complete' || tournament.draftComplete;
  const usernameMap = Object.fromEntries(users.map((u) => [u.uid, u.username]));
  const currentPick = draftState?.currentPickIndex ?? 0;
  const currentRound = Math.floor(currentPick / Math.max(tournament.draftOrder.length, 1)) + 1;
  const currentPickerName = currentPickerUid ? usernameMap[currentPickerUid] : '—';
  const myPicks = (draftState?.picks ?? []).filter((p) => p.userId === appUser.uid);
  const pickedIds = new Set((draftState?.picks ?? []).map((p) => p.playerId));
  // Track picked player keys using playerKey() — this applies the nickname map
  // so "Cam Davis" and "Cameron Davis" both resolve to the same key.
  // This catches ghost duplicates where the same player appears under different
  // name variants (odds vs ESPN) or was picked before ESPN IDs loaded.
  const pickedKeys = new Set(
    (draftState?.picks ?? []).map((p) => playerKey(p.playerName))
  );
  const hasEspnField = Object.keys(espnPlayers).length > 0;
  const hasOdds = oddsPlayers.length > 0;

  // Available players — not yet picked, filtered, sorted
  const available = mergedPlayers
    .filter((p) => {
      // Check ID-based membership (numeric ESPN IDs or stable name keys)
      if (pickedIds.has(p.id) || (p.espnId && pickedIds.has(p.espnId))) return false;
      // Check name-based — playerKey applies nickname map so "Cam Davis" == "Cameron Davis"
      // This catches ghost duplicates: same player appearing under both odds key AND ESPN key.
      if (pickedKeys.has(playerKey(p.displayName))) return false;
      if (p.espnName && pickedKeys.has(playerKey(p.espnName))) return false;
      if (searchTerm === '') return true;
      return p.displayName.toLowerCase().includes(searchTerm.toLowerCase());
    })
    .sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortMode === 'odds') {
        const ap = a.impliedProb ?? -1;
        const bp = b.impliedProb ?? -1;
        // Players without odds always go to bottom
        if (ap === -1 && bp !== -1) return 1;
        if (bp === -1 && ap !== -1) return -1;
        if (ap !== bp) return (bp - ap) * dir;  // default desc = favorites first
        return a.displayName.localeCompare(b.displayName);
      }
      if (sortMode === 'top10') {
        const ap = a.top10ImpliedProb ?? -1;
        const bp = b.top10ImpliedProb ?? -1;
        if (ap === -1 && bp !== -1) return 1;
        if (bp === -1 && ap !== -1) return -1;
        if (ap !== bp) return (bp - ap) * dir;
        return a.displayName.localeCompare(b.displayName);
      }
      if (sortMode === 'rank') {
        const ar = a.worldRanking ?? 9999;
        const br = b.worldRanking ?? 9999;
        // Unranked players go to bottom regardless of direction
        if (ar === 9999 && br !== 9999) return 1;
        if (br === 9999 && ar !== 9999) return -1;
        // Default asc for rank (lower number = better rank)
        return (ar - br) * dir;
      }
      if (sortMode === 'position') {
        const ap = a.position ?? 9999;
        const bp = b.position ?? 9999;
        if (ap === 9999 && bp !== 9999) return 1;
        if (bp === 9999 && ap !== 9999) return -1;
        return (ap - bp) * dir;
      }
      // name
      return a.displayName.localeCompare(b.displayName) * dir;
    });

  // ─── Sort handler ────────────────────────────────────────────────────────────

  function handleSortClick(mode: SortMode) {
    if (sortMode === mode) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortMode(mode);
      // Natural default direction per column
      setSortDir(mode === 'name' ? 'asc' : mode === 'rank' ? 'asc' : 'desc');
    }
  }

  function sortArrow(mode: SortMode) {
    if (sortMode !== mode) return <span className="text-slate-600 ml-0.5 text-xs">⇅</span>;
    return <span className="text-yellow-400 ml-0.5 text-xs">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

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
    <div className="min-h-screen page">
      <Navigation />

      {/* ── "Your turn" alert banner — pulses gold, tap to dismiss ── */}
      {myTurnAlert && (
        <div
          className="sticky top-0 z-40 flex items-center justify-between gap-3 px-4 py-3 text-sm font-bold cursor-pointer"
          style={{ background: 'linear-gradient(90deg, #A07A14, #C9A227, #D4B040, #C9A227, #A07A14)', color: '#030912', animation: 'pulse 1.5s ease-in-out infinite' }}
          onClick={() => setMyTurnAlert(false)}
        >
          <span>⛳ &nbsp;IT'S YOUR PICK — You're on the clock!</span>
          <span className="text-base opacity-70">✕</span>
        </div>
      )}

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

            {/* My roster — card design */}
            <div className="card-gold glow-gold">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-bebas text-lg tracking-wider text-white">My Team</h2>
                <div className="flex items-center gap-1.5">
                  {Array.from({ length: tournament.maxPicks }).map((_, i) => (
                    <div key={i} className="w-2 h-2 rounded-full transition-all"
                      style={{ background: i < myPicks.length ? '#C9A227' : 'rgba(255,255,255,0.12)' }} />
                  ))}
                  <span className="text-xs text-slate-500 ml-1">{myPicks.length}/{tournament.maxPicks}</span>
                </div>
              </div>
              {myPicks.length === 0 ? (
                <p className="text-slate-500 text-sm italic text-center py-4">Make your first pick →</p>
              ) : (
                <div className="space-y-2">
                  {myPicks.map((pick, i) => {
                    const merged = mergedPlayers.find(
                      (p) => p.espnId === pick.playerId || p.id === pick.playerId
                    );
                    const initials = pick.playerName.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();
                    return (
                      <div key={pick.playerId} className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center font-bold text-xs"
                          style={{ background: 'rgba(201,162,39,0.2)', color: '#D4AF37', border: '1px solid rgba(201,162,39,0.3)' }}>
                          {initials}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-white truncate">{pick.playerName}</div>
                          <div className="text-xs text-slate-500">Pick #{i + 1}</div>
                        </div>
                        {merged?.oddsDisplay && (
                          <span className="text-xs font-mono font-bold shrink-0"
                            style={{ color: 'rgba(201,162,39,0.7)' }}>{merged.oddsDisplay}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
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
                <h2 className="font-bold text-white flex items-center gap-2">
                  Available Players
                  <span className="text-slate-500 font-normal text-sm">({available.length})</span>
                  <button
                    onClick={() => { fetchOdds(true); if (tournament.espnEventId) fetchEspn(tournament.espnEventId, true); }}
                    title="Refresh player pool"
                    className="text-slate-500 hover:text-white text-xs px-1.5 py-0.5 rounded transition-colors"
                    style={{ background: 'rgba(255,255,255,0.06)' }}>
                    🔄
                  </button>
                </h2>

                {/* Quick-sort pills */}
                <div className="flex gap-1 text-xs flex-wrap">
                  {([
                    ['odds', '🏆 Win'],
                    ['top10', '🔟 Top 10'],
                    ['rank', '🌍 OWGR'],
                    ...(hasEspnField ? [['position', '🏌️ Pos']] as [SortMode, string][] : []),
                    ['name', 'A–Z'],
                  ] as [SortMode, string][]).map(([mode, label]) => (
                    <button key={mode} onClick={() => handleSortClick(mode)}
                      className={`px-2 py-1 rounded transition-colors ${
                        sortMode === mode ? 'bg-green-700 text-white' : 'bg-slate-700 text-slate-400 hover:text-white'
                      }`}>
                      {label}{sortMode === mode ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  ))}
                </div>
              </div>

              {/* Search */}
              <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search players…"
                className="input mb-3" />

              {/* Data source status banner */}
              {hasOdds && !hasEspnField && (
                <div className="mb-3 text-xs bg-yellow-900/20 border border-yellow-800/40 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                  <span className="text-yellow-400">⚠ ESPN field loading — picks may use name keys instead of ESPN IDs. Scoring will still work via name matching.</span>
                  <button onClick={() => tournament?.espnEventId && fetchEspn(tournament.espnEventId, true)}
                    className="shrink-0 text-yellow-300 underline">Retry ESPN</button>
                </div>
              )}
              {hasEspnField && (
                <div className="mb-2 text-xs text-green-600/70 flex items-center gap-1">
                  ✓ ESPN field loaded — picks linked to ESPN IDs (scoring guaranteed)
                  {oddsSource && <span className="text-slate-600 ml-1">· Odds: {oddsSource}</span>}
                </div>
              )}

              {/* Empty state */}
              {!hasOdds && !hasEspnField ? (
                <div className="text-center py-8 text-slate-500">
                  <p className="text-3xl mb-3">⛳</p>
                  <p className="font-semibold text-slate-300 text-base mb-1">Player pool loading…</p>
                  {tournament.espnEventId ? (
                    <p className="text-xs text-slate-400 mb-4">ESPN ID: <span className="font-mono text-green-400">{tournament.espnEventId}</span> — fetching field from ESPN</p>
                  ) : (
                    <p className="text-xs text-red-400 mb-4">⚠ No ESPN Event ID set — ask Gibbs to set it in Admin</p>
                  )}
                  <button
                    onClick={() => { fetchOdds(true); if (tournament.espnEventId) fetchEspn(tournament.espnEventId, true); }}
                    className="px-4 py-2 rounded-lg text-sm font-bold"
                    style={{ background: '#1B3A9E', color: 'white' }}>
                    🔄 Retry Loading Players
                  </button>
                  <p className="text-xs text-slate-600 mt-3">If this keeps failing, Gibbs can reload the page</p>
                </div>
              ) : (
                <div className="overflow-y-auto max-h-[30rem] pr-1">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-800 z-10">
                      <tr className="text-slate-400 text-xs border-b border-slate-700 select-none">
                        <th className="text-left py-2 pr-2 w-6">#</th>
                        <th className="text-left py-2 cursor-pointer hover:text-white transition-colors"
                            onClick={() => handleSortClick('name')}>
                          Player {sortArrow('name')}
                        </th>
                        <th className="text-right py-2 w-20 cursor-pointer hover:text-white transition-colors"
                            onClick={() => handleSortClick('odds')}
                            title="Odds to win the tournament">
                          Win {sortArrow('odds')}
                        </th>
                        <th className="text-right py-2 w-20 cursor-pointer hover:text-white transition-colors hidden md:table-cell"
                            onClick={() => handleSortClick('top10')}
                            title="Odds to finish top 10">
                          Top 10 {sortArrow('top10')}
                        </th>
                        <th className="text-right py-2 w-14 cursor-pointer hover:text-white transition-colors hidden sm:table-cell"
                            onClick={() => handleSortClick('rank')}
                            title="Official World Golf Ranking">
                          OWGR {sortArrow('rank')}
                        </th>
                        {hasEspnField && <>
                          <th className="text-right py-2 w-12 cursor-pointer hover:text-white transition-colors"
                              onClick={() => handleSortClick('position')}>
                            Pos {sortArrow('position')}
                          </th>
                          <th className="text-right py-2 w-10 hidden lg:table-cell text-slate-500">Thru</th>
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
                            {player.source === 'odds' && hasEspnField && (
                              <div className="text-xs text-yellow-600/60">⚠ no ESPN match yet</div>
                            )}
                          </td>
                          {/* Win odds */}
                          <td className="py-2 text-right">
                            {player.oddsDisplay && player.oddsDisplay !== 'N/A' ? (
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
                                  <div className="text-xs text-slate-500">{player.impliedProb.toFixed(1)}%</div>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-600 text-xs">—</span>
                            )}
                          </td>
                          {/* Top 10 odds */}
                          <td className="py-2 text-right hidden md:table-cell">
                            {player.top10Display ? (
                              <div>
                                <span className="font-mono text-sm font-semibold text-slate-300">
                                  {player.top10Display}
                                </span>
                                {player.top10ImpliedProb !== null && (
                                  <div className="text-xs text-slate-500">{player.top10ImpliedProb.toFixed(1)}%</div>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-600 text-xs">—</span>
                            )}
                          </td>
                          {/* OWGR */}
                          <td className="py-2 text-right hidden sm:table-cell">
                            {player.worldRanking ? (
                              <span className={`text-xs font-mono ${
                                player.worldRanking <= 10 ? 'text-yellow-300 font-semibold'
                                : player.worldRanking <= 50 ? 'text-slate-300'
                                : 'text-slate-500'
                              }`}>
                                #{player.worldRanking}
                              </span>
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
                            <td className="py-2 text-right text-xs text-slate-500 hidden lg:table-cell">
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
