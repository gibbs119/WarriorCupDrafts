'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import {
  getTournament,
  subscribeDraftState,
  subscribeWDRequests,
  subscribeRosterEdits,
  getAllUsers,
  approveWDRequest,
  denyWDRequest,
  adminEditRoster,
} from '@/lib/db';
import type { Tournament, DraftState, DraftPick, AppUser, WDReplacement, RosterEdit } from '@/lib/types';
import type { OddsPlayer } from '@/lib/odds';
import { ArrowRight, CheckCircle, XCircle, Clock, Edit2, History, AlertTriangle, Search } from 'lucide-react';

interface UserRoster {
  user: AppUser;
  picks: DraftPick[];
}

export default function AdminRostersPage() {
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const { appUser, loading } = useAuth();
  const router = useRouter();

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [wdRequests, setWdRequests] = useState<Record<string, WDReplacement>>({});
  const [rosterEdits, setRosterEdits] = useState<Record<string, RosterEdit>>({});
  const [availablePlayers, setAvailablePlayers] = useState<OddsPlayer[]>([]);

  // Inline edit state
  const [editingPick, setEditingPick] = useState<{ userId: string; pick: DraftPick } | null>(null);
  const [editSearch, setEditSearch] = useState('');
  const [editReason, setEditReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // Active tab
  const [tab, setTab] = useState<'rosters' | 'requests' | 'log'>('rosters');

  useEffect(() => {
    if (!loading && (!appUser || appUser.role !== 'admin')) router.push('/dashboard');
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    getTournament(tournamentId).then(setTournament);
    getAllUsers().then(setUsers);
    const u1 = subscribeDraftState(tournamentId, setDraftState);
    const u2 = subscribeWDRequests(tournamentId, setWdRequests);
    const u3 = subscribeRosterEdits(tournamentId, setRosterEdits);
    return () => { u1(); u2(); u3(); };
  }, [appUser, tournamentId]);

  const fetchAvailable = useCallback(async (currentDraftState: DraftState | null) => {
    if (!currentDraftState) return;
    const pickedIds = new Set(currentDraftState.picks.map((p) => p.playerId));
    try {
      const res = await fetch(`/api/odds?tournament=${tournamentId}`);
      if (!res.ok) return;
      const data = await res.json();
      setAvailablePlayers((data.players ?? []).filter((p: OddsPlayer) => !pickedIds.has(p.id)));
    } catch { /* ignore */ }
  }, [tournamentId]);

  // Lazy: only fetch available players when admin opens an edit panel
  // useEffect(() => { fetchAvailable(draftState); }, [draftState, fetchAvailable]);

  if (loading || !appUser || appUser.role !== 'admin' || !tournament) {
    return (
      <div className="min-h-screen"><Navigation />
        <div className="flex items-center justify-center h-64">
          <p className="font-bebas text-xl tracking-widest animate-pulse" style={{ color: '#C9A227' }}>LOADING…</p>
        </div>
      </div>
    );
  }

  // Build roster per user
  const rosters: UserRoster[] = users
    .filter((u) => u.role !== 'admin' || (draftState?.picks ?? []).some((p) => p.userId === u.uid))
    .map((u) => ({
      user: u,
      picks: (draftState?.picks ?? []).filter((p) => p.userId === u.uid),
    }))
    .filter((r) => r.picks.length > 0 || (draftState?.snakeDraftOrder ?? []).includes(r.user.uid));

  const pendingRequests = Object.entries(wdRequests).filter(([, r]) => r.status === 'pending');
  const editSearchLower = editSearch.toLowerCase();
  const filteredAvail = availablePlayers.filter((p) =>
    editSearch === '' || p.name.toLowerCase().includes(editSearchLower)
  );

  // ── WD request actions ───────────────────────────────────────────────────────

  async function handleApprove(key: string, req: WDReplacement) {
    setSaving(true); setMsg('');
    try {
      await approveWDRequest(tournamentId, key, req, appUser!.uid, appUser!.username);
      setMsg(`✅ Approved: ${req.droppedPlayerName} → ${req.replacementPlayerName} for ${req.username}`);
    } catch { setMsg('❌ Approval failed.'); }
    finally { setSaving(false); }
  }

  async function handleDeny(key: string, req: WDReplacement) {
    const note = prompt(`Optional note for ${req.username} (leave blank to skip):`);
    setSaving(true); setMsg('');
    try {
      await denyWDRequest(tournamentId, key, req, appUser!.username, note ?? undefined);
      setMsg(`Denied request from ${req.username}.`);
    } catch { setMsg('❌ Deny failed.'); }
    finally { setSaving(false); }
  }

  // ── Admin direct edit ────────────────────────────────────────────────────────

  async function handleAdminSwap(newPlayer: OddsPlayer) {
    if (!editingPick || !appUser) return;
    setSaving(true); setMsg('');
    try {
      await adminEditRoster(
        tournamentId,
        editingPick.userId,
        users.find((u) => u.uid === editingPick.userId)?.username ?? editingPick.userId,
        editingPick.pick.playerId,
        editingPick.pick.playerName,
        newPlayer.id,
        newPlayer.name,
        appUser.uid,
        appUser.username,
        editReason || 'Admin roster edit'
      );
      setMsg(`✅ Swapped ${editingPick.pick.playerName} → ${newPlayer.name}`);
      setEditingPick(null);
      setEditSearch('');
      setEditReason('');
    } catch { setMsg('❌ Swap failed.'); }
    finally { setSaving(false); }
  }

  async function handleAdminRemove(userId: string, pick: DraftPick) {
    if (!confirm(`Remove ${pick.playerName} from ${users.find(u=>u.uid===userId)?.username}'s roster? They will have an empty slot.`)) return;
    setSaving(true); setMsg('');
    try {
      // Use a sentinel "empty" replacement so the pick slot is cleared
      await adminEditRoster(
        tournamentId, userId,
        users.find((u) => u.uid === userId)?.username ?? userId,
        pick.playerId, pick.playerName,
        '__removed__', '[Removed]',
        appUser!.uid, appUser!.username,
        editReason || 'Admin removal'
      );
      setMsg(`Removed ${pick.playerName}.`);
    } catch { setMsg('❌ Remove failed.'); }
    finally { setSaving(false); }
  }

  const sortedEdits = Object.entries(rosterEdits).sort(([,a],[,b]) => b.editedAt - a.editedAt);

  return (
    <div className="min-h-screen">
      <Navigation />

      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[700px] h-56 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse, rgba(0,107,182,0.1) 0%, transparent 70%)' }} />

      <main className="relative z-10 max-w-5xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-slate-500 text-xs uppercase tracking-widest font-semibold mb-1">{tournament.name} · Admin</p>
            <h1 className="font-bebas text-4xl tracking-widest text-white flex items-center gap-3">
              <Edit2 size={28} style={{ color: '#C9A227' }} />
              Roster Manager
            </h1>
          </div>
          {pendingRequests.length > 0 && (
            <button onClick={() => setTab('requests')}
              className="btn-gold flex items-center gap-2">
              <AlertTriangle size={16} />
              {pendingRequests.length} Pending WD Request{pendingRequests.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>

        {msg && (
          <p className="mb-4 p-3 rounded-lg text-sm"
            style={{ background: msg.startsWith('✅') ? 'rgba(22,163,74,0.15)' : 'rgba(200,16,46,0.12)', color: msg.startsWith('✅') ? '#4ade80' : '#94a3b8' }}>
            {msg}
          </p>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-6">
          {([
            ['rosters', `📋 All Rosters`],
            ['requests', `🔔 WD Requests${pendingRequests.length > 0 ? ` (${pendingRequests.length})` : ''}`],
            ['log', '📜 Edit Log'],
          ] as [typeof tab, string][]).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all font-bebas tracking-wider"
              style={tab === t
                ? { background: 'rgba(0,107,182,0.3)', color: '#fff', border: '1px solid rgba(0,107,182,0.5)' }
                : { background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.07)' }}>
              {label}
            </button>
          ))}
        </div>

        {/* ── ROSTERS TAB ─────────────────────────────────────────────────── */}
        {tab === 'rosters' && (
          <div className="space-y-4">
            <p className="text-slate-500 text-sm">Click any player in a roster to swap them out. Changes are logged.</p>
            {rosters.length === 0 ? (
              <div className="card text-center py-12 text-slate-500">Draft picks not yet submitted.</div>
            ) : rosters.map(({ user, picks }) => (
              <div key={user.uid} className="card">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-bebas text-xl tracking-wider text-white">{user.username}</h2>
                  <span className="text-xs text-slate-500">{picks.filter(p => p.playerId !== '__removed__').length} / {tournament.maxPicks} picks</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {picks.map((pick) => {
                    const isEditing = editingPick?.userId === user.uid && editingPick?.pick.playerId === pick.playerId;
                    const isRemoved = pick.playerId === '__removed__';
                    return (
                      <div key={pick.playerId}>
                        <div
                          onClick={() => !isRemoved && if (!isEditing) { setEditingPick({ userId: user.uid, pick }); if (availablePlayers.length === 0) fetchAvailable(draftState); } else { setEditingPick(null); }}
                          className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm cursor-pointer transition-all"
                          style={{
                            background: isEditing   ? 'rgba(201,162,39,0.15)' :
                                        isRemoved   ? 'rgba(200,16,46,0.08)' :
                                        'rgba(255,255,255,0.04)',
                            border: `1px solid ${isEditing   ? 'rgba(201,162,39,0.4)' :
                                                  isRemoved   ? 'rgba(200,16,46,0.25)' :
                                                  'rgba(255,255,255,0.07)'}`,
                          }}>
                          <span className="text-slate-600 text-xs w-5">{pick.round}.</span>
                          <span className={`font-medium flex-1 ${isRemoved ? 'text-slate-600 line-through' : 'text-white'}`}>
                            {isRemoved ? '[Empty slot]' : pick.playerName}
                          </span>
                          {(pick as any).replacedFrom && (
                            <span className="text-xs text-slate-500 font-mono">✎</span>
                          )}
                          {!isRemoved && <Edit2 size={11} className="text-slate-600" />}
                        </div>

                        {/* Inline swap panel */}
                        {isEditing && (
                          <div className="mt-1 p-3 rounded-lg space-y-2"
                            style={{ background: 'rgba(0,107,182,0.1)', border: '1px solid rgba(0,107,182,0.3)' }}>
                            <p className="text-xs text-slate-400 font-semibold">
                              Replacing <span style={{ color: '#C9A227' }}>{pick.playerName}</span>
                            </p>
                            <input
                              type="text"
                              value={editSearch}
                              onChange={(e) => setEditSearch(e.target.value)}
                              placeholder="Search available players…"
                              className="input text-xs py-1.5"
                              autoFocus
                            />
                            <input
                              type="text"
                              value={editReason}
                              onChange={(e) => setEditReason(e.target.value)}
                              placeholder="Reason (optional, e.g. WD, admin correction)…"
                              className="input text-xs py-1.5"
                            />
                            <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                              {filteredAvail.slice(0, 30).map((p) => (
                                <button key={p.id} onClick={() => handleAdminSwap(p)} disabled={saving}
                                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-all disabled:opacity-50"
                                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)' }}>
                                  <span className="font-medium text-white flex-1">{p.name}</span>
                                  {p.oddsDisplay && <span className="font-mono text-slate-400">{p.oddsDisplay}</span>}
                                </button>
                              ))}
                              {filteredAvail.length === 0 && editSearch && (
                                <p className="text-slate-500 text-xs italic p-2">No matches. Try a different name.</p>
                              )}
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => handleAdminRemove(user.uid, pick)} disabled={saving}
                                className="btn-danger text-xs py-1 px-2">
                                Remove (empty slot)
                              </button>
                              <button onClick={() => { setEditingPick(null); setEditSearch(''); setEditReason(''); }}
                                className="btn-secondary text-xs py-1 px-2">
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── WD REQUESTS TAB ─────────────────────────────────────────────── */}
        {tab === 'requests' && (
          <div className="space-y-4">
            {Object.keys(wdRequests).length === 0 ? (
              <div className="card text-center py-12">
                <p className="text-slate-400 font-medium">No WD replacement requests yet.</p>
                <p className="text-slate-500 text-sm mt-1">Users submit requests from the WD Replacement page on their dashboard.</p>
              </div>
            ) : Object.entries(wdRequests)
              .sort(([,a],[,b]) => {
                const order = { pending: 0, denied: 1, approved: 2 };
                return (order[a.status] ?? 9) - (order[b.status] ?? 9);
              })
              .map(([key, req]) => (
                <div key={key} className="card">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bebas text-lg tracking-wider text-white">{req.username}</span>
                        <span className="text-xs px-2 py-0.5 rounded font-bold capitalize"
                          style={{
                            background: req.status === 'approved' ? 'rgba(22,163,74,0.15)' :
                                        req.status === 'denied'   ? 'rgba(200,16,46,0.12)' :
                                        'rgba(201,162,39,0.15)',
                            color: req.status === 'approved' ? '#4ade80' :
                                   req.status === 'denied'   ? '#f87171' : '#C9A227',
                          }}>
                          {req.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium" style={{ color: '#f87171' }}>{req.droppedPlayerName}</span>
                        <ArrowRight size={14} className="text-slate-500" />
                        <span className="font-medium text-green-400">{req.replacementPlayerName}</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        Requested {new Date(req.requestedAt).toLocaleDateString()} at {new Date(req.requestedAt).toLocaleTimeString()}
                        {req.approvedBy && ` · ${req.status === 'approved' ? 'Approved' : 'Denied'} by ${req.approvedBy}`}
                      </p>
                      {req.note && <p className="text-xs text-yellow-600 mt-1">Note: {req.note}</p>}
                    </div>

                    {req.status === 'pending' && (
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => handleApprove(key, req)} disabled={saving}
                          className="btn-primary text-sm py-1.5 px-3 disabled:opacity-50">
                          <CheckCircle size={14} /> Approve
                        </button>
                        <button onClick={() => handleDeny(key, req)} disabled={saving}
                          className="btn-danger text-sm py-1.5 px-3 disabled:opacity-50">
                          <XCircle size={14} /> Deny
                        </button>
                      </div>
                    )}
                    {req.status !== 'pending' && (
                      <div className="flex items-center gap-1 text-sm">
                        {req.status === 'approved' ? <CheckCircle size={16} className="text-green-400" /> : <XCircle size={16} className="text-red-400" />}
                        <span className="text-slate-400">{req.approvedBy}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* ── EDIT LOG TAB ─────────────────────────────────────────────────── */}
        {tab === 'log' && (
          <div>
            <p className="text-slate-500 text-sm mb-4">Complete audit trail of all roster changes for this tournament.</p>
            {sortedEdits.length === 0 ? (
              <div className="card text-center py-12 text-slate-500">No edits yet.</div>
            ) : (
              <div className="card">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-500 text-xs uppercase tracking-wider" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                      <th className="text-left py-2 pr-4">Time</th>
                      <th className="text-left py-2 pr-4">User</th>
                      <th className="text-left py-2 pr-4">Change</th>
                      <th className="text-left py-2 pr-4">By</th>
                      <th className="text-left py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedEdits.map(([key, edit]) => (
                      <tr key={key} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td className="py-2 pr-4 text-slate-500 text-xs whitespace-nowrap">
                          {new Date(edit.editedAt).toLocaleDateString()}<br/>
                          <span className="text-slate-600">{new Date(edit.editedAt).toLocaleTimeString()}</span>
                        </td>
                        <td className="py-2 pr-4 font-semibold text-white">{edit.username}</td>
                        <td className="py-2 pr-4">
                          <span style={{ color: '#f87171' }}>{edit.oldPickName}</span>
                          <ArrowRight size={11} className="inline mx-1 text-slate-600" />
                          <span className="text-green-400">{edit.newPickName}</span>
                        </td>
                        <td className="py-2 pr-4 text-slate-400">{edit.editedByName}</td>
                        <td className="py-2 text-slate-500 text-xs">{edit.reason ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
