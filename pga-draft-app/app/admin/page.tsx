'use client';

import Link from 'next/link';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import {
  getAllTournaments,
  updateTournament,
  initializeDraft,
  getAllUsers,
  getDraftState,
  getDraftOrderFromResults,
  saveRankedOrder,
} from '@/lib/db';
import { buildSnakeDraftOrder, calculateLeaderboard } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import { USERS, TOURNAMENTS } from '@/lib/constants';
import type { Tournament, AppUser } from '@/lib/types';
import { Settings, Users, Trophy, Plus, Shuffle } from 'lucide-react';

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

  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [userMsg, setUserMsg] = useState('');
  const [lockMsg, setLockMsg] = useState('');
  const [seeding, setSeeding] = useState(false);

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

  // ── Randomize (The Players only) ──────────────────────────────────────────

  function randomizeDraftOrder() {
    if (users.length === 0) {
      setMsg('⚠ No registered users found. Create accounts first.');
      return;
    }
    setDraftOrderInput(shuffleArray(users.map((u) => u.uid)));
  }

  // ── Load order from previous tournament results ───────────────────────────

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

  // ── Mark Final: compute ranking → save → auto-set next tournament order ───

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
            rankedUids = scores.map((s) => s.userId); // rank 1 first
          }
        }
      }

      // Fallback to existing draft order if ESPN data unavailable
      if (rankedUids.length === 0 && t.draftOrder?.length > 0) {
        rankedUids = [...t.draftOrder];
        setMsg('⚠ ESPN data unavailable — using draft order as fallback ranking.');
      }

      if (rankedUids.length > 0) await saveRankedOrder(t.id, rankedUids);

      await updateTournament(t.id, { status: 'completed' });

      // Auto-propagate to next tournament
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
        setMsg(`✅ ${t.name} marked Final. Draft order for ${nextName} auto-set from results (1st picks 1st).`);
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

  async function openDraft(t: Tournament) {
    if (!t.draftOrder || t.draftOrder.length < 2) {
      setMsg('⚠ Set the draft order first — use Randomize (The Players) or load from previous results.');
      return;
    }
    setSaving(true);
    try {
      const totalPicks = t.maxPicks * t.draftOrder.length;
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
    setUserMsg('Creating default users via server…');
    let created = 0;
    for (const u of USERS) {
      try {
        const res = await fetch('/api/admin/create-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: u.email, password: 'changeme123', username: u.username, role: u.role }),
        });
        if (res.ok) created++;
      } catch { /* already exists — skip */ }
    }
    setUserMsg(`✅ Done! ${created} users created. Default password: changeme123`);
    setUsers(await getAllUsers());
  }

  // ─── Lock scores manually ───────────────────────────────────────────────────
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

  // ─── Seed historical data ────────────────────────────────────────────────────
  async function seedHistoricalData() {
    setSeeding(true);
    setLockMsg('Importing historical data…');
    try {
      const res = await fetch('/api/admin/seed-history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': process.env.NEXT_PUBLIC_CRON_SECRET ?? '',
        },
        body: JSON.stringify({ overwrite: false }),
      });
      const data = await res.json();
      if (res.ok) {
        setLockMsg(`✅ Imported ${data.imported} tournaments (${data.skipped} already existed).`);
      } else {
        setLockMsg(`❌ Seed failed: ${data.error}`);
      }
    } catch {
      setLockMsg('❌ Network error during seed.');
    } finally {
      setSeeding(false);
    }
  }

  if (loading || !appUser) {
    return (
      <div className="min-h-screen"><Navigation />
        <div className="flex items-center justify-center h-64 font-bebas text-xl tracking-widest animate-pulse" style={{color:"#C9A227"}}>LOADING…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Navigation />
      <main className="max-w-4xl mx-auto px-4 py-6">

        <div className="mb-6">
          <h1 className="font-bebas text-3xl tracking-wider text-white flex items-center gap-2">
            <Settings size={24} className="text-yellow-400" /> Admin Panel
          </h1>
          <p className="text-slate-400 text-sm mt-1">Manage tournaments, drafts, and user accounts</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          {(['tournaments', 'users'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-bold font-bebas tracking-wider uppercase transition-all ${
                tab === t ? 'bg-green-700 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}>
              {t === 'tournaments' ? <Trophy size={14} className="inline mr-1" /> : <Users size={14} className="inline mr-1" />}
              {t}
            </button>
          ))}
        </div>

        {/* ── Tournaments Tab ── */}
        {tab === 'tournaments' && (
          <div className="space-y-4">
            {msg && <p className="text-sm p-3 bg-slate-800 border border-slate-700 rounded-lg">{msg}</p>}
            {lockMsg && <p className="text-sm p-3 card-gold rounded-lg">{lockMsg}</p>}

            {tournaments.map((t) => {
              const seqIdx = TOURNAMENT_SEQUENCE.indexOf(t.id);
              const isFirst = seqIdx === 0;
              const prevTournament = seqIdx > 0 ? tournaments.find((x) => x.id === TOURNAMENT_SEQUENCE[seqIdx - 1]) : null;

              return (
                <div key={t.id} className="card">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-white">{t.name}</h3>
                      <p className="text-slate-400 text-xs mt-0.5">
                        Status: <span className={
                          t.status === 'active' ? 'text-green-400' :
                          t.status === 'drafting' ? 'text-yellow-400' :
                          t.status === 'completed' ? 'text-slate-500' : 'text-white'
                        }>{t.status}</span>
                        {' · '}ESPN ID: <span className="font-mono text-green-400">{t.espnEventId || '⚠ not set'}</span>
                        {' · '}Cut: {t.cutLine}
                        {' · '}Draft order: {t.draftOrder?.length ? `${t.draftOrder.length} users` : '⚠ not set'}
                      </p>
                      {t.status === 'upcoming' && (
                        <p className="text-slate-500 text-xs mt-1 italic">
                          {isFirst
                            ? '🎲 The Players: open Edit and click Randomize to set the draft order'
                            : prevTournament?.status === 'completed'
                            ? `📋 Draft order auto-set from ${prevTournament.name} results`
                            : `📋 Draft order will auto-populate when ${prevTournament?.name ?? 'previous tournament'} is marked Final`}
                        </p>
                      )}
                    </div>

                    <div className="flex gap-2 flex-wrap justify-end shrink-0">
                      <button onClick={() => startEdit(t)} className="btn-secondary text-xs py-1 px-2">Edit</button>
                      {t.status === 'upcoming' && (
                        <button onClick={() => openDraft(t)} disabled={saving || !t.draftOrder?.length}
                          className="btn-gold text-xs py-1 px-2 disabled:opacity-40 disabled:cursor-not-allowed">
                          Open Draft
                        </button>
                      )}
                      {t.status === 'drafting' && (
                        <button onClick={() => setTournamentStatus(t, 'active')} disabled={saving}
                          className="btn-primary text-xs py-1 px-2">Set Live</button>
                      )}
                      {t.status === 'active' && (
                        <>
                          <button onClick={() => lockTournamentScores(t)} disabled={saving}
                            className="btn-gold text-xs py-1 px-2 disabled:opacity-50"
                            title="Snapshot ESPN scores to Firebase permanently">
                            🔒 Lock Scores
                          </button>
                          <button onClick={() => markFinal(t)} disabled={saving}
                            className="btn-secondary text-xs py-1 px-2 disabled:opacity-50">
                            Mark Final
                          </button>
                        </>
                      )}
                      <Link href={`/admin/rosters/${t.id}`}
                        className="btn-secondary text-xs py-1 px-2">
                        👥 Rosters
                      </Link>
                      {(t as any).scoreLocked && (
                        <span className="text-xs px-2 py-0.5 rounded font-semibold"
                          style={{background:'rgba(201,162,39,0.15)',color:'#C9A227',border:'1px solid rgba(201,162,39,0.3)'}}>
                          🔒 Locked
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Edit form */}
                  {editingId === t.id && (
                    <div className="mt-4 border-t border-slate-700 pt-4 space-y-4">
                      <div>
                        <label className="text-xs text-slate-400 block mb-1">
                          ESPN Event ID <span className="text-slate-500">(from espn.com/golf/leaderboard/_/tournamentId/<strong>XXXXX</strong>)</span>
                        </label>
                        <input type="text" value={espnId} onChange={(e) => setEspnId(e.target.value)}
                          placeholder="e.g. 401580349"
                          className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-green-600" />
                      </div>

                      <div>
                        <label className="text-xs text-slate-400 block mb-1">Cut Line Position (e.g. 65)</label>
                        <input type="number" value={cutLine} onChange={(e) => setCutLine(Number(e.target.value))}
                          className="w-32 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-green-600" />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-xs text-slate-400">
                            Draft Order <span className="text-slate-500">(Round 1 — snake reverses each round automatically)</span>
                          </label>
                          <div className="flex gap-2">
                            {isFirst && (
                              <button onClick={randomizeDraftOrder}
                                className="flex items-center gap-1 bg-purple-700 hover:bg-purple-600 text-white text-xs py-1 px-2 rounded-lg transition-colors">
                                <Shuffle size={12} /> Randomize
                              </button>
                            )}
                            {!isFirst && (
                              <button onClick={() => loadOrderFromPrevious(t.id)} disabled={saving}
                                className="flex items-center gap-1 bg-blue-700 hover:bg-blue-600 text-white text-xs py-1 px-2 rounded-lg transition-colors disabled:opacity-50">
                                📋 Load from Previous
                              </button>
                            )}
                          </div>
                        </div>

                        <DraftOrderEditor userIds={draftOrderInput} users={users} onChange={setDraftOrderInput} />

                        {/* Snake preview */}
                        {draftOrderInput.length > 0 && (
                          <details className="mt-2">
                            <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-300 select-none">
                              Preview snake order ({draftOrderInput.length * (t.maxPicks || 5)} total picks)
                            </summary>
                            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 text-xs max-h-48 overflow-y-auto">
                              {buildSnakeDraftOrder(draftOrderInput, draftOrderInput.length * (t.maxPicks || 5)).map((uid, i) => {
                                const u = users.find((x) => x.uid === uid);
                                const isNewRound = i > 0 && i % draftOrderInput.length === 0;
                                return (
                                  <div key={i} className={`flex gap-1.5 py-0.5 ${isNewRound ? 'mt-1' : ''}`}>
                                    <span className="text-slate-600 w-5 text-right shrink-0">{i + 1}.</span>
                                    <span className="text-slate-300">{u?.username ?? uid.slice(0, 6)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        )}
                      </div>

                      <div className="flex gap-2">
                        <button onClick={saveTournament} disabled={saving} className="btn-primary text-sm">
                          {saving ? 'Saving…' : 'Save Changes'}
                        </button>
                        <button onClick={() => setEditingId(null)} className="btn-secondary text-sm">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Users Tab ── */}
        {tab === 'users' && (
          <div className="space-y-6">
            <div className="card-gold">
              <h3 className="font-bebas text-xl tracking-wider text-white mb-1">Quick Setup</h3>
              <p className="text-slate-400 text-sm mb-3">
                First-time setup — create all 8 default accounts at once. Default password:{' '}
                <code className="text-yellow-300">changeme123</code>
              </p>
              <button onClick={initAllUsers} className="btn-gold text-sm">Create All 8 Default Users</button>
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
                      <th className="text-left py-2 font-mono text-xs">UID</th>
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
                        <td className="py-2 font-mono text-xs text-slate-500 max-w-xs truncate">{u.uid}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h3 className="font-bebas text-xl tracking-wider text-white mb-3">Create Individual Account</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="Username"
                  className="input" />
                <input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Email" type="email"
                  className="input" />
                <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Password" type="password"
                  className="input" />
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
  const unselected = users.filter((u) => !userIds.includes(u.uid));
  const selected = userIds.map((uid) => users.find((u) => u.uid === uid)).filter(Boolean) as AppUser[];

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
              <button onClick={() => i > 0 && move(i, -1)} className="text-slate-400 hover:text-white px-1 disabled:opacity-30" disabled={i === 0}>▲</button>
              <button onClick={() => i < userIds.length - 1 && move(i, 1)} className="text-slate-400 hover:text-white px-1 disabled:opacity-30" disabled={i === userIds.length - 1}>▼</button>
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
