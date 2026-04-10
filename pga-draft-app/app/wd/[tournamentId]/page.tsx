'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import {
  getTournament,
  subscribeDraftState,
  subscribeMyWDRequests,
  submitWDRequest,
} from '@/lib/db';
import { playerKey, type OddsPlayer } from '@/lib/odds';
import type { Tournament, DraftState, DraftPick, WDReplacement } from '@/lib/types';
import { AlertTriangle, CheckCircle, Clock, XCircle, ArrowRight, RefreshCw, Eye } from 'lucide-react';
import toast from 'react-hot-toast';

export default function WDReplacementPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { appUser, loading, isViewMode } = useAuth();
  const router = useRouter();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [myRequests, setMyRequests] = useState<Record<string, WDReplacement>>({});
  const [availablePlayers, setAvailablePlayers] = useState<OddsPlayer[]>([]);

  // Selection state
  const [selectedDrop, setSelectedDrop] = useState<DraftPick | null>(null);
  const [selectedReplacement, setSelectedReplacement] = useState<OddsPlayer | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    getTournament(tournamentId).then(setTournament);
    const unsub = subscribeDraftState(tournamentId, setDraftState);
    const unsubReq = subscribeMyWDRequests(tournamentId, appUser.uid, setMyRequests);
    return () => { unsub(); unsubReq(); };
  }, [appUser, tournamentId]);

  // Fetch available players (from odds API, excluding already-drafted)
  const fetchAvailable = useCallback(async () => {
    if (!draftState) return;
    const pickedIds = new Set(draftState.picks.map((p) => p.playerId));
    const pickedKeys = new Set(draftState.picks.map((p) => playerKey(p.playerName)));

    try {
      const res = await fetch(`/api/odds?tournament=${tournamentId}`);
      if (!res.ok) return;
      const data = await res.json();
      const players: OddsPlayer[] = (data.players ?? []).filter((p: OddsPlayer) => {
        return !pickedIds.has(p.id) && !pickedKeys.has(p.id);
      });
      setAvailablePlayers(players);
    } catch {
      // silently ignore
    }
  }, [draftState, tournamentId]);

  useEffect(() => { fetchAvailable(); }, [fetchAvailable]);

  if (loading || !appUser || !tournament) {
    return (
      <div className="min-h-screen page"><Navigation />
        <div className="flex items-center justify-center h-64">
          <p className="font-bebas text-xl tracking-widest animate-pulse" style={{ color: '#C9A227' }}>LOADING…</p>
        </div>
      </div>
    );
  }

  const myPicks = (draftState?.picks ?? []).filter((p) => p.userId === appUser.uid);
  const pendingRequests = (Object.values(myRequests) as WDReplacement[]).filter((r) => r.status === 'pending');
  const approvedRequests = (Object.values(myRequests) as WDReplacement[]).filter((r) => r.status === 'approved');
  const deniedRequests = (Object.values(myRequests) as WDReplacement[]).filter((r) => r.status === 'denied');

  // Picks that are already being replaced (pending or approved)
  const requestedDropIds = new Set((Object.values(myRequests) as WDReplacement[]).map((r) => r.droppedPlayerId));

  const filteredAvailable = availablePlayers.filter((p) =>
    searchTerm === '' || p.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  async function handleSubmit() {
    if (!selectedDrop || !selectedReplacement || !appUser) return;
    setSubmitting(true);
    try {
      const request: WDReplacement = {
        userId: appUser.uid,
        username: appUser.username,
        droppedPlayerId: selectedDrop.playerId,
        droppedPlayerName: selectedDrop.playerName,
        replacementPlayerId: selectedReplacement.id,
        replacementPlayerName: selectedReplacement.espnName ?? selectedReplacement.name,
        requestedAt: Date.now(),
        status: 'pending',
      };
      await submitWDRequest(tournamentId, request);
      // Notify admin — fire and forget
      fetch('/api/notify-wd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId,
          username: appUser.username,
          droppedPlayerName: selectedDrop.playerName,
          replacementPlayerName: selectedReplacement.espnName ?? selectedReplacement.name,
        }),
      }).catch(() => {});
      toast.success('Request submitted! Gibbs will approve it shortly.');
      setSelectedDrop(null);
      setSelectedReplacement(null);
    } catch {
      toast.error('Failed to submit. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // View-only mode: show info banner, hide submission form
  if (isViewMode) {
    return (
      <div className="min-h-screen page">
        <Navigation />
        <main className="relative z-10 max-w-3xl mx-auto px-4 py-8">
          <div className="card flex items-center gap-4" style={{ border: '1px solid rgba(96,165,250,0.3)', background: 'rgba(96,165,250,0.06)' }}>
            <Eye size={24} style={{ color: '#60a5fa', flexShrink: 0 }} />
            <div>
              <p className="font-semibold text-white text-sm">View Only</p>
              <p className="text-slate-400 text-xs mt-0.5">WD replacement requests are not available in view-only mode.</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen page">
      <Navigation />

      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[700px] h-56 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse, rgba(201,162,39,0.08) 0%, transparent 70%)' }} />

      <main className="relative z-10 max-w-3xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="mb-6">
          <p className="text-slate-500 text-xs uppercase tracking-widest font-semibold mb-1">{tournament.name}</p>
          <h1 className="font-bebas text-4xl tracking-widest text-white flex items-center gap-3">
            <AlertTriangle size={28} style={{ color: '#C9A227' }} />
            WD Replacement
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Request a replacement for a player who withdrew before Thursday's first tee time.
            All replacements require admin approval.
          </p>
        </div>

        {/* Rules callout */}
        <div className="card-gold mb-6 text-sm text-slate-300 space-y-1">
          <p className="font-semibold text-white mb-1">📋 Replacement Rules</p>
          <p>• Only players who officially withdraw <strong>before</strong> they tee off Thursday are eligible for replacement.</p>
          <p>• Replacement must be an undrafted player from the tournament field.</p>
          <p>• One replacement request per withdrawn player — Gibbs reviews and approves all requests.</p>
          <p>• Post-cut WDs and mid-round withdrawals do <strong>not</strong> qualify for replacement.</p>
        </div>

        {/* Existing requests status */}
        {Object.keys(myRequests).length > 0 && (
          <div className="card mb-6">
            <h2 className="font-bebas text-xl tracking-wider text-white mb-3">My Requests</h2>
            <div className="space-y-2">
              {[...pendingRequests, ...approvedRequests, ...deniedRequests].map((req: WDReplacement, i: number) => (
                <div key={i} className="flex items-center gap-3 text-sm p-3 rounded-lg"
                  style={{
                    background: req.status === 'approved' ? 'rgba(22,163,74,0.1)' :
                                req.status === 'denied'   ? 'rgba(200,16,46,0.1)' :
                                'rgba(201,162,39,0.08)',
                    border: `1px solid ${req.status === 'approved' ? 'rgba(22,163,74,0.3)' :
                                         req.status === 'denied'   ? 'rgba(200,16,46,0.3)' :
                                         'rgba(201,162,39,0.25)'}`,
                  }}>
                  {req.status === 'approved' ? <CheckCircle size={16} className="text-green-400 shrink-0" /> :
                   req.status === 'denied'   ? <XCircle    size={16} className="text-red-400 shrink-0" /> :
                                               <Clock      size={16} style={{ color: '#C9A227' }} className="shrink-0 animate-pulse" />}
                  <div className="flex-1">
                    <span className="font-medium text-white">{req.droppedPlayerName}</span>
                    <ArrowRight size={12} className="inline mx-1 text-slate-500" />
                    <span className="font-medium text-white">{req.replacementPlayerName}</span>
                  </div>
                  <span className="text-xs font-bold capitalize px-2 py-0.5 rounded"
                    style={{
                      color: req.status === 'approved' ? '#4ade80' : req.status === 'denied' ? '#f87171' : '#C9A227',
                      background: req.status === 'approved' ? 'rgba(22,163,74,0.15)' : req.status === 'denied' ? 'rgba(200,16,46,0.15)' : 'rgba(201,162,39,0.15)',
                    }}>
                    {req.status}
                  </span>
                  {req.note && <p className="text-xs text-slate-500 mt-1 w-full">{req.note}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* New request form */}
        <div className="card">
          <h2 className="font-bebas text-xl tracking-wider text-white mb-4">New Replacement Request</h2>

          {tournament.status !== 'active' ? (
            <div className="text-center py-8">
              <p className="text-slate-400 font-medium mb-1">
                {tournament.status === 'completed' ? '🏆 This tournament has concluded.' :
                 tournament.status === 'upcoming'  ? '⏳ Tournament has not started yet.' :
                 '⏸ WD replacements are not available right now.'}
              </p>
              <p className="text-slate-500 text-sm">Requests can only be submitted during an active tournament.</p>
            </div>
          ) : myPicks.length === 0 ? (
            <p className="text-slate-500 italic text-sm">No picks found for this tournament.</p>
          ) : (
            <div className="space-y-6">

              {/* Step 1: pick who to drop */}
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Step 1 — Select your withdrawn player
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {myPicks.map((pick) => {
                    const alreadyRequested = requestedDropIds.has(pick.playerId);
                    const isSelected = selectedDrop?.playerId === pick.playerId;
                    return (
                      <button
                        key={pick.playerId}
                        disabled={alreadyRequested}
                        onClick={() => { setSelectedDrop(isSelected ? null : pick); setSelectedReplacement(null); }}
                        className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          background: isSelected ? 'rgba(201,162,39,0.2)' : 'rgba(255,255,255,0.05)',
                          border: `1px solid ${isSelected ? 'rgba(201,162,39,0.5)' : 'rgba(255,255,255,0.08)'}`,
                        }}>
                        <span className="text-slate-500 text-xs w-5">{pick.round}.</span>
                        <span className="font-medium text-white flex-1">{pick.playerName}</span>
                        {alreadyRequested && <span className="text-xs text-slate-500">requested</span>}
                        {isSelected && <span style={{ color: '#C9A227' }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Step 2: pick replacement */}
              {selectedDrop && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                    Step 2 — Select your replacement for <span style={{ color: '#C9A227' }}>{selectedDrop.playerName}</span>
                  </p>
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      type="text"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Search available players…"
                      className="input flex-1"
                    />
                    <button onClick={fetchAvailable} className="btn-secondary px-2 py-2" title="Refresh">
                      <RefreshCw size={14} />
                    </button>
                  </div>

                  <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
                    {filteredAvailable.length === 0 ? (
                      <p className="text-slate-500 text-sm italic py-4 text-center">
                        No available players found. The draft room may still be open or odds haven't loaded.
                      </p>
                    ) : filteredAvailable.map((player) => {
                      const isSelected = selectedReplacement?.id === player.id;
                      return (
                        <button
                          key={player.id}
                          onClick={() => setSelectedReplacement(isSelected ? null : player)}
                          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-left transition-all"
                          style={{
                            background: isSelected ? 'rgba(0,107,182,0.25)' : 'rgba(255,255,255,0.04)',
                            border: `1px solid ${isSelected ? 'rgba(0,107,182,0.5)' : 'rgba(255,255,255,0.06)'}`,
                          }}>
                          <span className="font-medium text-white flex-1">{player.name}</span>
                          {player.oddsDisplay && (
                            <span className="font-mono text-xs"
                              style={{ color: player.americanOdds !== null && player.americanOdds < 0 ? '#4ade80' : '#C9A227' }}>
                              {player.oddsDisplay}
                            </span>
                          )}
                          {isSelected && <span className="text-blue-400">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Step 3: confirm */}
              {selectedDrop && selectedReplacement && (
                <div>
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                    Step 3 — Confirm
                  </p>
                  <div className="card-royal flex items-center gap-4 mb-4 flex-wrap">
                    <div className="text-center">
                      <p className="text-xs text-slate-500 mb-1">Dropping</p>
                      <p className="font-semibold text-white">{selectedDrop.playerName}</p>
                    </div>
                    <ArrowRight size={20} style={{ color: '#C9A227' }} className="shrink-0" />
                    <div className="text-center">
                      <p className="text-xs text-slate-500 mb-1">Adding</p>
                      <p className="font-semibold text-white">{selectedReplacement.name}</p>
                      {selectedReplacement.oddsDisplay && (
                        <p className="text-xs font-mono" style={{ color: '#C9A227' }}>{selectedReplacement.oddsDisplay}</p>
                      )}
                    </div>
                  </div>
                  <button onClick={handleSubmit} disabled={submitting} className="btn-gold w-full py-3 text-base font-bebas tracking-widest justify-center">
                    {submitting ? '⏳ SUBMITTING…' : '📨 SUBMIT REPLACEMENT REQUEST'}
                  </button>
                </div>
              )}

            </div>
          )}
        </div>
      </main>
    </div>
  );
}
