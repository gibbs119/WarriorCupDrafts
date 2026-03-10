'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import {
  getAllTournaments, updateTournament, initializeDraft,
  getAllUsers, getDraftState, getDraftOrderFromResults, saveRankedOrder,
  resetDraft, clearDraftPicks,
} from '@/lib/db';
import { buildSnakeDraftOrder, calculateLeaderboard } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import { USERS, TOURNAMENTS } from '@/lib/constants';
import type { Tournament, AppUser } from '@/lib/types';
import { Settings, Users, Trophy, Plus, Shuffle, Zap } from 'lucide-react';

const TOURNAMENT_SEQUENCE = TOURNAMENTS.map((t) => t.id);

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function AdminPage() {
  const { appUser, loading } = useAuth();
  const router = useRouter();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [tab, setTab] = useState<'tournaments' | 'users'>('tournaments');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [espnId, setEspnId] = useState('');
  const [cutLine, setCutLine] = useState(65);
  const [draftOrderInput, setDraftOrderInput] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [lockMsg, setLockMsg] = useState('');
  const [seeding, setSeeding] = useState(false);

  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [userMsg, setUserMsg] = useState('');

  useEffect(() => {
    if (!loading) {
      if (!appUser) router.push('/');
      else if (appUser.role !== 'admin') router.push('/dashboard');
    }
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [ts, us] = await Promise.all([getAllTournaments(), getAllUsers()]);
      ts.sort((a, b) => TOURNAMENT_SEQUENCE.indexOf(a.id) - TOURNAMENT_SEQUENCE.indexOf(b.id));
      setTournaments(ts);
      setUsers(us);
    }
    load();
  }, [appUser]);

  function startEdit(t: Tournament) {
    setEditingId(t.id);
    setEspnId(t.espnEventId ?? '');
    setCutLine(t.cutLine ?? 65);
    setDraftOrderInput(t.draftOrder ?? []);
    setMsg('');
  }

  async function saveTournament() {
    if (!editingId) return;
    setSaving(true);
    setMsg('');
    try {
      await updateTournament(editingId, { espnEventId: espnId, cutLine, draftOrder: draftOrderInput });
      setTournaments((prev) =>
        prev.map((t) =>
          t.id === editingId ? { ...t, espnEventId: espnId, cutLine, draftOrder: draftOrderInput } : t
        )
      );
      setMsg('✅ Saved!');
      setEditingId(null);
    } catch {
      setMsg('❌ Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function randomizeDraftOrder() {
    if (users.length === 0) {
      setMsg('⚠ No registered users found — create accounts first (Users tab).');
      return;
    }
    setDraftOrderInput(shuffleArray(users.map((u) => u.uid)));
    setMsg('🎲 Draft order randomized! Click Save Changes to confirm.');
  }

  async function loadOrderFromPrevious(currentId: string) {
    const idx = TOURNAMENT_SEQUENCE.indexOf(currentId);
    if (idx <= 0) return;
    const prevId = TOURNAMENT_SEQUENCE[idx - 1];
    setSaving(true);
    setMsg('Loading previous results…');
    try {
      const savedOrder = await getDraftOrderFromResults(prevId);
      if (savedOrder && savedOrder.length > 0) {
        setDraftOrderInput(savedOrder);
        setMsg('✅ Draft order loaded from previous tournament finishing positions.');
      } else {
        setMsg('⚠ No saved results for the previous tournament. Mark it Final first.');
      }
    } catch {
      setMsg('❌ Failed to load previous results.');
    } finally {
      setSaving(false);
    }
  }


  // ── Reset entire draft (wipes all picks + sets back to upcoming) ──────────
  async function handleResetDraft(t: Tournament) {
    if (!confirm(`⚠️ RESET ENTIRE DRAFT for ${t.name}?\n\nThis will DELETE all picks and set the tournament back to Upcoming. This cannot be undone.`)) return;
    setSaving(true);
    setMsg('Resetting draft…');
    try {
      await resetDraft(t.id);
      setTournaments((prev) => prev.map((x) => x.id === t.id ? { ...x, status: 'upcoming', draftComplete: false } : x));
      setMsg(`✅ Draft reset for ${t.name}. You can now re-launch.`);
    } catch {
      setMsg('❌ Reset failed.');
    } finally {
      setSaving(false);
    }
  }

  // ── Clear picks only (keeps draft room open, resets to pick #1) ───────────
  async function handleGenerateSummary(t: Tournament) {
    if (!window.confirm(`Generate daily summary for ${t.name}? This will trigger the AI recap.`)) return;
    setSaving(true);
    try {
      const res = await fetch('/api/cron/daily-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: process.env.NEXT_PUBLIC_ADMIN_SEED_SECRET ?? 'pgadraft2025secret', tournamentId: t.id }),
      });
      const data = await res.json();
      if (data.ok) alert('✅ Daily summary generated! Users will see it next time they open the app.');
      else if (data.skipped) alert(`Skipped: ${data.reason}`);
      else alert(`Error: ${data.error ?? 'Unknown'}`);
    } catch {
      alert('Failed to generate summary');
    } finally {
      setSaving(false);
    }
  }

  async function handleClearPicks(t: Tournament) {
    if (!confirm(`Clear all picks for ${t.name}?\n\nThe draft room stays open but everyone starts over from pick #1.`)) return;
    setSaving(true);
    setMsg('Clearing picks…');
    try {
      await clearDraftPicks(t.id);
      setMsg(`✅ All picks cleared for ${t.name}. Draft room is still open — pick #1 is up.`);
    } catch {
      setMsg('❌ Clear picks failed.');
    } finally {
      setSaving(false);
    }
  }

  // ── ONE-CLICK LAUNCH for tonight's draft ─────────────────────────────────
  async function quickLaunchDraft(t: Tournament) {
    if (users.length === 0) {
      setMsg('⚠ No users found. Go to the Users tab and click "Create All 8 Default Users" first.');
      return;
    }
    setSaving(true);
    setMsg('🚀 Launching draft…');
    try {
      // 1. Randomize order
      const randomOrder = shuffleArray(users.map((u) => u.uid));
      // 2. Save ESPN ID + draft order
      await updateTournament(t.id, {
        espnEventId: t.espnEventId || '401811937',
        draftOrder: randomOrder,
        cutLine: t.cutLine || 65,
      });
      // 3. Initialize snake draft + open it
      const totalPicks = (t.maxPicks || 5) * randomOrder.length;
      const snakeOrder = buildSnakeDraftOrder(randomOrder, totalPicks);
      await initializeDraft(t.id, snakeOrder);
      await updateTournament(t.id, { status: 'drafting' });
      setTournaments((prev) =>
        prev.map((x) =>
          x.id === t.id ? { ...x, status: 'drafting', draftOrder: randomOrder, espnEventId: t.espnEventId || '401811937' } : x
        )
      );
      setMsg(`✅ Draft is OPEN for ${t.name}! Share the link with everyone now.`);
    } catch (e) {
      console.error(e);
      setMsg('❌ Launch failed — check console for details.');
    } finally {
      setSaving(false);
    }
  }

  async function openDraft(t: Tournament) {
    if (!t.draftOrder || t.draftOrder.length < 2) {
      setMsg('⚠ Set draft order first — click Edit then Randomize.');
      return;
    }
    setSaving(true);
    try {
      const totalPicks = (t.maxPicks || 5) * t.draftOrder.length;
      const snakeOrder = buildSnakeDraftOrder(t.draftOrder, totalPicks);
      await initializeDraft(t.id, snakeOrder);
      await updateTournament(t.id, { status: 'drafting' });
      setTournaments((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: 'drafting' } : x)));
      setMsg(`✅ Draft opened for ${t.name}!`);
    } catch {
      setMsg('❌ Failed to open draft.');
    } finally {
      setSaving(false);
    }
  }

  async function setTournamentStatus(t: Tournament, status: Tournament['status']) {
    setSaving(true);
    try {
      await updateTournament(t.id, { status });
      setTournaments((prev) => prev.map((x) => (x.id === t.id ? { ...x, status } : x)));
    } finally {
      setSaving(false);
    }
  }

  async function markFinal(t: Tournament) {
    setSaving(true);
    setMsg('Calculating final standings…');
    try {
      let rankedUids: string[] = [];
      if (t.espnEventId) {
        const res = await fetch(`/api/espn/leaderboard?eventId=${t.espnEventId}`);
        if (res.ok) {
          const data = await res.json();
          const { players: playersMap, cutLine: espnCut } = parseLeaderboard(data);
          const cutVal = espnCut ?? t.cutLine ?? 65;
          const draftState = await getDraftState(t.id);
          if (draftState && draftState.picks.length > 0) {
            const allUsers = await getAllUsers();
            const userPicksMap: Record<string, { username: string; picks: typeof draftState.picks }> = {};
            for (const u of allUsers) {
              const picks = draftState.picks.filter((p) => p.userId === u.uid);
              if (picks.length > 0) userPicksMap[u.uid] = { username: u.username, picks };
            }
            const scores = calculateLeaderboard(userPicksMap, playersMap, cutVal);
            rankedUids = scores.map((s) => s.userId);
          }
        }
      }
      if (rankedUids.length === 0 && t.draftOrder?.length > 0) {
        rankedUids = [...t.draftOrder];
        setMsg('⚠ ESPN data unavailable — using draft order as fallback ranking.');
      }
      if (rankedUids.length > 0) await saveRankedOrder(t.id, rankedUids);
      await updateTournament(t.id, { status: 'completed' });

      const nextIdx = TOURNAMENT_SEQUENCE.indexOf(t.id) + 1;
      if (nextIdx < TOURNAMENT_SEQUENCE.length && rankedUids.length > 0) {
        const nextId = TOURNAMENT_SEQUENCE[nextIdx];
        await updateTournament(nextId, { draftOrder: rankedUids });
        const nextName = tournaments.find((x) => x.id === nextId)?.name ?? 'next tournament';
        setTournaments((prev) =>
          prev.map((x) => {
            if (x.id === t.id) return { ...x, status: 'completed' };
            if (x.id === nextId) return { ...x, draftOrder: rankedUids };
            return x;
          })
        );
        setMsg(`✅ ${t.name} marked Final. Draft order for ${nextName} set automatically.`);
      } else {
        setTournaments((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: 'completed' } : x)));
        setMsg(`✅ ${t.name} marked Final.`);
      }
    } catch (e) {
      console.error(e);
      setMsg('❌ Failed to mark Final.');
    } finally {
      setSaving(false);
    }
  }

  async function lockTournamentScores(t: Tournament) {
    setSaving(true);
    setLockMsg('Fetching final scores from ESPN…');
    try {
      const res = await fetch('/api/admin/lock-scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId: t.id, lockedBy: appUser?.username }),
      });
      const data = await res.json();
      if (res.ok) {
        setLockMsg(`✅ Scores locked for ${t.name}! ${data.teamScores?.length ?? 0} teams recorded.`);
        setTournaments((prev) => prev.map((x) => x.id === t.id ? { ...x, status: 'completed', scoreLocked: true } as typeof x : x));
      } else {
        setLockMsg(`❌ Lock failed: ${data.error}`);
      }
    } catch {
      setLockMsg('❌ Network error during lock.');
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateUser() {
    if (!newUsername || !newEmail || !newPassword) return;
    setUserMsg('');
    try {
      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, password: newPassword, username: newUsername, role: 'user' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUserMsg(`✅ Account created for ${newUsername}`);
      setNewUsername(''); setNewEmail(''); setNewPassword('');
      setUsers(await getAllUsers());
    } catch (e: unknown) {
      setUserMsg(`❌ ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
  }

  async function initAllUsers() {
    setUserMsg('Creating accounts…');
    let created = 0;
    for (const u of USERS) {
      try {
        const res = await fetch('/api/admin/create-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: u.email, password: 'changeme123', username: u.username, role: u.role }),
        });
        if (res.ok) created++;
      } catch { /* already exists */ }
    }
    setUserMsg(`✅ Done! ${created} users created. Default password: changeme123`);
    setUsers(await getAllUsers());
  }

  async function seedHistoricalData() {
    setSeeding(true);
    setLockMsg('Importing historical data…');
    try {
      const res = await fetch('/api/admin/seed-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': process.env.NEXT_PUBLIC_CRON_SECRET ?? '' },
        body: JSON.stringify({ overwrite: false }),
      });
      const data = await res.json();
      if (res.ok) setLockMsg(`✅ Imported ${data.imported} tournaments (${data.skipped} already existed).`);
      else setLockMsg(`❌ Seed failed: ${data.error}`);
    } catch {
      setLockMsg('❌ Network error during seed.');
    } finally {
      setSeeding(false);
    }
  }

  if (loading || !appUser) {
    return (
      <div className="min-h-screen page"><Navigation />
        <div className="flex items-center justify-center h-64 font-bebas text-xl tracking-widest animate-pulse" style={{ color: '#C9A227' }}>LOADING…</div>
      </div>
    );
  }

  // Find the next upcoming tournament that needs a draft
  const nextDraftTournament = tournaments.find((t) => t.status === 'upcoming');

  return (
    <div className="min-h-screen page">
      <Navigation />
      <main className="max-w-4xl mx-auto px-4 py-6">

        <div className="mb-6">
          <h1 className="font-bebas text-3xl tracking-wider text-white flex items-center gap-2">
            <Settings size={24} className="text-yellow-400" /> Admin Panel
          </h1>
          <p className="text-slate-400 text-sm mt-1">Manage tournaments, drafts, and user accounts</p>
        </div>

        {/* ── QUICK LAUNCH BANNER ────────────────────────────────────────────── */}
        {nextDraftTournament && nextDraftTournament.status === 'upcoming' && (
          <div className="mb-6 rounded-2xl p-5 border-2" style={{ background: 'rgba(201,162,39,0.08)', borderColor: '#C9A227' }}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="font-bebas text-2xl tracking-wider text-white flex items-center gap-2">
                  <Zap size={20} style={{ color: '#C9A227' }} />
                  TONIGHT: {nextDraftTournament.name}
                </p>
                <p className="text-slate-300 text-sm mt-1">
                  Tournament: <strong className="text-white">{nextDraftTournament.startDate}</strong>
                  {' · '}Draft night: <strong className="text-white">{(nextDraftTournament as any).draftDate ?? 'Tonight'}</strong>
                </p>
                <p className="text-slate-400 text-xs mt-2">
                  {users.length === 0
                    ? '⚠ Step 1: Go to the Users tab and click "Create All 8 Default Users" first.'
                    : `✅ ${users.length} users ready · ESPN ID: ${nextDraftTournament.espnEventId || '401811937'}`}
                </p>
              </div>
              <button
                onClick={() => quickLaunchDraft(nextDraftTournament)}
                disabled={saving || users.length === 0}
                className="font-bebas tracking-widest text-lg px-6 py-3 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                style={{ background: '#C9A227', color: '#0D1F38' }}
              >
                {saving ? 'LAUNCHING…' : '🚀 LAUNCH DRAFT NOW'}
              </button>
            </div>
            {msg && <p className="mt-3 text-sm font-semibold" style={{ color: msg.startsWith('✅') ? '#4ade80' : msg.startsWith('⚠') ? '#fbbf24' : '#f87171' }}>{msg}</p>}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          {(['tournaments', 'users'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-bold font-bebas tracking-wider uppercase transition-all ${
                tab === t ? 'text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
              style={tab === t ? { background: '#1B3A9E' } : {}}>
              {t === 'tournaments' ? <Trophy size={14} className="inline mr-1" /> : <Users size={14} className="inline mr-1" />}
              {t}
            </button>
          ))}
        </div>

        {/* ── Tournaments Tab ── */}
        {tab === 'tournaments' && (
          <div className="space-y-4">
            {msg && !nextDraftTournament && <p className="text-sm p-3 bg-slate-800 border border-slate-700 rounded-lg">{msg}</p>}
            {lockMsg && <p className="text-sm p-3 card-gold rounded-lg">{lockMsg}</p>}

            {tournaments.map((t) => {
              const seqIdx = TOURNAMENT_SEQUENCE.indexOf(t.id);
              const isFirst = seqIdx === 0;
              const prevTournament = seqIdx > 0 ? tournaments.find((x) => x.id === TOURNAMENT_SEQUENCE[seqIdx - 1]) : null;
              const statusColor = t.status === 'active' ? '#4ade80' : t.status === 'drafting' ? '#C9A227' : t.status === 'completed' ? '#475569' : '#e2e8f0';

              return (
                <div key={t.id} className="card">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-white">{t.name}</h3>
                        <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(255,255,255,0.08)', color: statusColor }}>
                          {t.status.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-slate-400 text-xs mt-1">
                        📅 {t.startDate}
                        {(t as any).draftDate && <span className="text-slate-500"> · Draft: {(t as any).draftDate}</span>}
                      </p>
                      <p className="text-slate-500 text-xs mt-0.5">
                        ESPN ID: <span className="font-mono" style={{ color: t.espnEventId ? '#4ade80' : '#f87171' }}>{t.espnEventId || '⚠ not set'}</span>
                        {' · '}Cut: {t.cutLine}
                        {' · '}Draft order: <span style={{ color: t.draftOrder?.length ? '#4ade80' : '#f87171' }}>{t.draftOrder?.length ? `${t.draftOrder.length} users ✓` : '⚠ not set'}</span>
                      </p>
                    </div>

                    <div className="flex gap-2 flex-wrap justify-end shrink-0">
                      {/* Edit is always available */}
                      <button onClick={() => startEdit(t)} className="btn-secondary text-xs py-1.5 px-3">
                        ✏️ Edit
                      </button>

                      {/* Open Draft — only when upcoming AND draft order set */}
                      {t.status === 'upcoming' && t.draftOrder?.length > 0 && (
                        <button onClick={() => openDraft(t)} disabled={saving}
                          className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                          style={{ background: '#C9A227', color: '#0D1F38' }}>
                          Open Draft
                        </button>
                      )}

                      {/* Status transitions */}
                      {t.status === 'drafting' && (
                        <button onClick={() => setTournamentStatus(t, 'active')} disabled={saving}
                          className="btn-primary text-xs py-1.5 px-3">Set Live</button>
                      )}
                      {t.status === 'active' && (
                        <>
                          <button onClick={() => lockTournamentScores(t)} disabled={saving}
                            className="text-xs py-1.5 px-3 rounded-lg font-bold disabled:opacity-40"
                            style={{ background: '#C9A227', color: '#0D1F38' }}>
                            🔒 Lock Scores
                          </button>
                          <button onClick={() => markFinal(t)} disabled={saving}
                            className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50">
                            Mark Final
                          </button>
                          <button onClick={() => handleGenerateSummary(t)} disabled={saving}
                            className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                            style={{ background: 'rgba(139,92,246,0.15)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.3)' }}>
                            🤖 Daily Summary
                          </button>
                        </>
                      )}

                      <Link href={`/admin/rosters/${t.id}`} className="btn-secondary text-xs py-1.5 px-3">
                        👥 Rosters
                      </Link>

                      {/* Reset controls — always visible */}
                      {(t.status === 'drafting' || t.status === 'active') && (
                        <button onClick={() => handleClearPicks(t)} disabled={saving}
                          className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                          style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                          ↺ Clear Picks
                        </button>
                      )}
                      {t.status !== 'upcoming' && (
                        <button onClick={() => handleResetDraft(t)} disabled={saving}
                          className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                          style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}>
                          🗑 Full Reset
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Edit form */}
                  {editingId === t.id && (
                    <div className="mt-4 border-t border-slate-700 pt-4 space-y-4">
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          ESPN Event ID <span className="text-slate-500">(from espn.com URL — already filled for The Players)</span>
                        </label>
                        <input type="text" value={espnId} onChange={(e) => setEspnId(e.target.value)}
                          placeholder="e.g. 401811937"
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-600" />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Cut Line Position</label>
                        <input type="number" value={cutLine} onChange={(e) => setCutLine(Number(e.target.value))}
                          className="w-32 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600" />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-xs text-slate-400">
                            Draft Order <span className="text-slate-500">(snake reverses each round automatically)</span>
                          </label>
                          <div className="flex gap-2">
                            {isFirst && (
                              <button onClick={randomizeDraftOrder}
                                className="flex items-center gap-1 text-white text-xs py-1 px-2 rounded-lg transition-colors"
                                style={{ background: '#6d28d9' }}>
                                <Shuffle size={12} /> Randomize
                              </button>
                            )}
                            {!isFirst && (
                              <button onClick={() => loadOrderFromPrevious(t.id)} disabled={saving}
                                className="flex items-center gap-1 btn-primary text-xs py-1 px-2 disabled:opacity-50">
                                📋 Load from Previous
                              </button>
                            )}
                          </div>
                        </div>
                        <DraftOrderEditor userIds={draftOrderInput} users={users} onChange={setDraftOrderInput} />
                        {draftOrderInput.length > 0 && (
                          <details className="mt-2">
                            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300 select-none">
                              Preview snake order ({draftOrderInput.length * (t.maxPicks || 5)} total picks)
                            </summary>
                            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 text-xs max-h-48 overflow-y-auto">
                              {buildSnakeDraftOrder(draftOrderInput, draftOrderInput.length * (t.maxPicks || 5)).map((uid, i) => {
                                const u = users.find((x) => x.uid === uid);
                                return (
                                  <div key={i} className="flex gap-1.5 py-0.5">
                                    <span className="text-slate-600 w-5 text-right shrink-0">{i + 1}.</span>
                                    <span className="text-slate-300">{u?.username ?? uid.slice(0, 6)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        )}
                      </div>

                      {msg && <p className="text-sm" style={{ color: msg.startsWith('✅') ? '#4ade80' : '#fbbf24' }}>{msg}</p>}

                      <div className="flex gap-2">
                        <button onClick={saveTournament} disabled={saving} className="btn-primary text-sm">
                          {saving ? 'Saving…' : 'Save Changes'}
                        </button>
                        <button onClick={() => { setEditingId(null); setMsg(''); }} className="btn-secondary text-sm">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Lock scores / seed section */}
            <div className="card mt-6">
              <h3 className="font-bebas text-lg tracking-wider text-white mb-3">Historical Data</h3>
              <p className="text-slate-400 text-sm mb-3">Import pick history from 2019–2025 for the History page.</p>
              <button onClick={seedHistoricalData} disabled={seeding} className="btn-secondary text-sm disabled:opacity-50">
                {seeding ? 'Importing…' : '📂 Import Historical Picks'}
              </button>
              {lockMsg && <p className="mt-2 text-sm">{lockMsg}</p>}
            </div>
          </div>
        )}

        {/* ── Users Tab ── */}
        {tab === 'users' && (
          <div className="space-y-6">
            <div className="rounded-2xl p-5 border-2" style={{ background: 'rgba(201,162,39,0.08)', borderColor: '#C9A227' }}>
              <h3 className="font-bebas text-xl tracking-wider text-white mb-1">Quick Setup</h3>
              <p className="text-slate-400 text-sm mb-3">
                Creates all 8 accounts. Default password: <code className="text-yellow-300">changeme123</code>
              </p>
              <button onClick={initAllUsers} className="font-bebas tracking-widest px-5 py-2.5 rounded-xl text-base"
                style={{ background: '#C9A227', color: '#0D1F38' }}>
                Create All 8 Default Users
              </button>
              {userMsg && <p className="mt-2 text-sm">{userMsg}</p>}
            </div>

            <div className="card">
              <h3 className="font-bebas text-xl tracking-wider text-white mb-3">Registered Users ({users.length})</h3>
              {users.length === 0 ? (
                <p className="text-slate-500 text-sm italic">No users yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-slate-700">
                      <th className="text-left py-2">Username</th>
                      <th className="text-left py-2">Email</th>
                      <th className="text-left py-2">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.uid} className="border-b border-slate-700/50">
                        <td className="py-2 font-medium text-white">{u.username}</td>
                        <td className="py-2 text-slate-400 text-xs">{u.email}</td>
                        <td className="py-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${u.role === 'admin' ? 'bg-yellow-700 text-yellow-100' : 'bg-slate-700 text-slate-300'}`}>
                            {u.role}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h3 className="font-bebas text-xl tracking-wider text-white mb-3">Create Individual Account</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="Username" className="input" />
                <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email" type="email" className="input" />
                <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Password" type="password" className="input" />
              </div>
              <button onClick={handleCreateUser} className="btn-primary text-sm">
                <Plus size={14} className="inline mr-1" /> Create Account
              </button>
              {userMsg && <p className="mt-2 text-sm">{userMsg}</p>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function DraftOrderEditor({ userIds, users, onChange }: { userIds: string[]; users: AppUser[]; onChange: (ids: string[]) => void }) {
  const selected = userIds.map((uid) => users.find((u) => u.uid === uid)).filter(Boolean) as AppUser[];
  const unselected = users.filter((u) => !userIds.includes(u.uid));

  function move(index: number, dir: -1 | 1) {
    const n = [...userIds];
    [n[index], n[index + dir]] = [n[index + dir], n[index]];
    onChange(n);
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="space-y-1">
          {selected.map((u, i) => (
            <div key={u.uid} className="flex items-center gap-2 bg-slate-700 rounded-lg px-3 py-1.5 text-sm">
              <span className="text-slate-400 w-5">{i + 1}.</span>
              <span className="flex-1 text-white">{u.username}</span>
              <button onClick={() => i > 0 && move(i, -1)} disabled={i === 0} className="text-slate-400 hover:text-white px-1 disabled:opacity-30">▲</button>
              <button onClick={() => i < userIds.length - 1 && move(i, 1)} disabled={i === userIds.length - 1} className="text-slate-400 hover:text-white px-1 disabled:opacity-30">▼</button>
              <button onClick={() => onChange(userIds.filter((id) => id !== u.uid))} className="text-red-400 hover:text-red-300 px-1">✕</button>
            </div>
          ))}
        </div>
      )}
      {unselected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {unselected.map((u) => (
            <button key={u.uid} onClick={() => onChange([...userIds, u.uid])}
              className="bg-slate-600 hover:bg-slate-500 text-slate-300 text-xs px-2 py-1 rounded">
              + {u.username}
            </button>
          ))}
        </div>
      )}
      {selected.length === 0 && unselected.length === 0 && (
        <p className="text-slate-500 text-xs">No registered users found. Create accounts first.</p>
      )}
    </div>
  );
}
