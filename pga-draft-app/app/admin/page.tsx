'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import {
  getAllTournaments, updateTournament, initializeDraft,
  getAllUsers, getDraftState, getDraftOrderFromResults, saveRankedOrder,
  resetDraft, clearDraftPicks, undoLastPick, getReedRuleStatus, setReedRuleStatus,
  importDraftPicks, createTournamentsBatch,
} from '@/lib/db';
import { buildSnakeDraftOrder, calculateLeaderboard } from '@/lib/scoring';
import { parseLeaderboard } from '@/lib/espn';
import { USERS, TOURNAMENTS, STANDARD_TOURNAMENTS } from '@/lib/constants';
import type { Tournament, AppUser } from '@/lib/types';
import { Settings, Users, Trophy, Plus, Shuffle, Calendar, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';

const TOURNAMENT_SEQUENCE = TOURNAMENTS.map((t) => t.id);

interface SeasonSlot {
  id: string;
  name: string;
  shortName: string;
  fieldSize: number;
  maxPicks: number;
  cutLine: number;
  sequence: number;
  espnEventId: string;
  startDate: string;
  draftDate: string;
  liveScoresStart: string;
}

function makeDefaultSlots(): SeasonSlot[] {
  return STANDARD_TOURNAMENTS.map(t => ({
    ...t, espnEventId: '', startDate: '', draftDate: '', liveScoresStart: '',
  }));
}

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
  const [draftOrderInput, setDraftOrderInput] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [refreshingStats, setRefreshingStats] = useState(false);
  const [generatingRecap, setGeneratingRecap] = useState(false);
  const [recapPickingId, setRecapPickingId] = useState<string | null>(null);
  const [recapError, setRecapError] = useState<{ tournamentId: string; msg: string } | null>(null);
  const [reedRuleStates, setReedRuleStates] = useState<Record<string, boolean>>({});
  const [reedRuleSaving, setReedRuleSaving] = useState<string | null>(null);

  // Emergency picks import
  const [importPicksId, setImportPicksId] = useState<string | null>(null);
  const [importPickInputs, setImportPickInputs] = useState<Record<string, string>>({});

  // Season setup
  const [seasonSetupOpen, setSeasonSetupOpen] = useState(false);
  const [newSeasonYear, setNewSeasonYear] = useState(new Date().getFullYear() + 1);
  const [stdSlots, setStdSlots] = useState<SeasonSlot[]>(makeDefaultSlots());
  const [extraSlots, setExtraSlots] = useState<SeasonSlot[]>([]);
  const [creatingSeason, setCreatingSeason] = useState(false);

  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // User editing
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [savingUser, setSavingUser] = useState(false);

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
      ts.sort((a, b) => {
        const seqA = a.sequence ?? TOURNAMENT_SEQUENCE.indexOf(a.id) + 1;
        const seqB = b.sequence ?? TOURNAMENT_SEQUENCE.indexOf(b.id) + 1;
        return seqA - seqB;
      });
      setTournaments(ts);
      setUsers(us);
      // Load Reed Rule status for all tournaments
      const reedStates: Record<string, boolean> = {};
      await Promise.all(ts.map(async (t) => {
        reedStates[t.id] = await getReedRuleStatus(t.id);
      }));
      setReedRuleStates(reedStates);
    }
    load();
  }, [appUser]);

  function startEdit(t: Tournament) {
    setEditingId(t.id);
    setEspnId(t.espnEventId ?? '');
    setDraftOrderInput(t.draftOrder ?? []);
  }

  async function saveTournament() {
    if (!editingId) return;
    setSaving(true);
    try {
      await updateTournament(editingId, { espnEventId: espnId, draftOrder: draftOrderInput });
      setTournaments((prev) =>
        prev.map((t) =>
          t.id === editingId ? { ...t, espnEventId: espnId, draftOrder: draftOrderInput } : t
        )
      );
      toast.success('Saved!');
      setEditingId(null);
    } catch {
      toast.error('Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function randomizeDraftOrder() {
    if (users.length === 0) {
      toast.error('No registered users found — create accounts first (Users tab).');
      return;
    }
    setDraftOrderInput(shuffleArray(users.map((u) => u.uid)));
    toast.success('Draft order randomized! Click Save Changes to confirm.');
  }

  async function loadOrderFromPrevious(currentId: string) {
    const idx = TOURNAMENT_SEQUENCE.indexOf(currentId);
    if (idx <= 0) return;
    const prevId = TOURNAMENT_SEQUENCE[idx - 1];
    setSaving(true);
    try {
      const savedOrder = await getDraftOrderFromResults(prevId);
      if (savedOrder && savedOrder.length > 0) {
        setDraftOrderInput(savedOrder);
        toast.success('Draft order loaded from previous tournament finishing positions.');
      } else {
        toast('No saved results for the previous tournament. Mark it Final first.', { icon: '⚠️' });
      }
    } catch {
      toast.error('Failed to load previous results.');
    } finally {
      setSaving(false);
    }
  }


  // ── Reset entire draft (wipes all picks + sets back to upcoming) ──────────
  async function handleResetDraft(t: Tournament) {
    if (!confirm(`⚠️ RESET ENTIRE DRAFT for ${t.name}?\n\nThis will DELETE all picks and set the tournament back to Upcoming. This cannot be undone.`)) return;
    setSaving(true);
    try {
      await resetDraft(t.id);
      setTournaments((prev) => prev.map((x) => x.id === t.id ? { ...x, status: 'upcoming', draftComplete: false } : x));
      toast.success(`Draft reset for ${t.name}. You can now re-launch.`);
    } catch {
      toast.error('Reset failed.');
    } finally {
      setSaving(false);
    }
  }

  // ── Undo only the single most-recent pick ────────────────────────────────
  async function handleUndoLastPick(t: Tournament) {
    if (!confirm(`Undo the last pick for ${t.name}?\n\nThe most recent pick will be removed and that player returns to the available pool. Everything else stays.`)) return;
    setSaving(true);
    try {
      const undone = await undoLastPick(t.id);
      if (undone) toast.success(`Undid pick: ${undone} is back in the pool.`);
      else toast('No picks to undo.', { icon: 'ℹ️' });
    } catch {
      toast.error('Undo failed.');
    } finally {
      setSaving(false);
    }
  }

  // ── Clear picks only (keeps draft room open, resets to pick #1) ───────────
  async function handleClearPicks(t: Tournament) {
    if (!confirm(`Clear all picks for ${t.name}?\n\nThe draft room stays open but everyone starts over from pick #1.`)) return;
    setSaving(true);
    try {
      await clearDraftPicks(t.id);
      toast.success(`All picks cleared for ${t.name}. Draft room is still open — pick #1 is up.`);
    } catch {
      toast.error('Clear picks failed.');
    } finally {
      setSaving(false);
    }
  }

  // ── ONE-CLICK LAUNCH for tonight's draft ─────────────────────────────────
  async function quickLaunchDraft(t: Tournament) {
    if (users.length === 0) {
      toast.error('No users found. Go to the Users tab and click "Create All 8 Default Users" first.');
      return;
    }
    setSaving(true);
    try {
      // 1. Randomize order
      const randomOrder: string[] = shuffleArray(users.map((u) => u.uid));
      // 2. Save ESPN ID + draft order
      await updateTournament(t.id, {
        espnEventId: t.espnEventId,
        draftOrder: randomOrder,
        cutLine: 65,
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
      toast.success(`Draft is OPEN for ${t.name}! Share the link with everyone.`);
    } catch (e) {
      console.error(e);
      toast.error('Launch failed — check console for details.');
    } finally {
      setSaving(false);
    }
  }

  async function openDraft(t: Tournament) {
    if (!t.draftOrder || t.draftOrder.length < 2) {
      toast('Set draft order first — click Edit then Randomize.', { icon: '⚠️' });
      return;
    }
    setSaving(true);
    try {
      const totalPicks = (t.maxPicks || 5) * t.draftOrder.length;
      const snakeOrder = buildSnakeDraftOrder(t.draftOrder, totalPicks);
      await initializeDraft(t.id, snakeOrder);
      await updateTournament(t.id, { status: 'drafting' });
      setTournaments((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: 'drafting' } : x)));
      toast.success(`Draft opened for ${t.name}!`);
    } catch {
      toast.error('Failed to open draft.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleReedRule(tournamentId: string) {
    const next = !reedRuleStates[tournamentId];
    setReedRuleSaving(tournamentId);
    try {
      await setReedRuleStatus(tournamentId, next);
      setReedRuleStates((prev) => ({ ...prev, [tournamentId]: next }));
      toast.success(next ? '🚩 Reed Rule ACTIVATED — team is disqualified' : '✅ Reed Rule deactivated — normal scoring restored');
    } catch {
      toast.error('Failed to update Reed Rule status.');
    } finally {
      setReedRuleSaving(null);
    }
  }

  async function handleImportPicks(t: Tournament) {
    const maxPicks = t.maxPicks || 5;
    const picks: import('@/lib/types').DraftPick[] = [];
    let pickNumber = 1;
    const filledUsers = users.filter((u) => (importPickInputs[u.uid] ?? '').trim());
    if (filledUsers.length === 0) {
      toast.error('Enter at least one user\'s picks before importing.');
      return;
    }
    for (const u of filledUsers) {
      const raw = importPickInputs[u.uid] ?? '';
      const names = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      if (names.length !== maxPicks) {
        toast.error(`${u.username} needs exactly ${maxPicks} picks (got ${names.length})`);
        return;
      }
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        picks.push({
          userId: u.uid,
          username: u.username,
          playerId: name, // scoring engine falls back to name matching
          playerName: name,
          pickNumber: pickNumber++,
          round: i + 1,
          timestamp: Date.now(),
        });
      }
    }
    setSaving(true);
    try {
      await importDraftPicks(t.id, picks, users.map((u) => u.uid));
      toast.success(`Picks imported for ${t.name}! Leaderboard should load now.`);
      setImportPicksId(null);
      setImportPickInputs({});
    } catch (e) {
      console.error(e);
      toast.error('Import failed — check console for details.');
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
    const toastId = toast.loading('Calculating final standings…');
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
        toast('ESPN data unavailable — using draft order as fallback ranking.', { icon: '⚠️', id: toastId });
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
        toast.success(`${t.name} marked Final. Draft order for ${nextName} set automatically.`, { id: toastId });
      } else {
        setTournaments((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: 'completed' } : x)));
        toast.success(`${t.name} marked Final.`, { id: toastId });
      }
    } catch (e) {
      console.error(e);
      toast.error('Failed to mark Final.', { id: toastId });
    } finally {
      setSaving(false);
    }
  }

  async function lockTournamentScores(t: Tournament) {
    setSaving(true);
    const toastId = toast.loading('Fetching final scores from ESPN…');
    try {
      const res = await fetch('/api/admin/lock-scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId: t.id, lockedBy: appUser?.username }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Scores locked for ${t.name}! ${data.teamScores?.length ?? 0} teams recorded.`, { id: toastId });
        setTournaments((prev) => prev.map((x) => x.id === t.id ? { ...x, status: 'completed', scoreLocked: true } : x));
        // fire-and-forget — auto-refresh all-time stats after each lock
        fetch('/api/admin/refresh-alltime-stats', { method: 'POST' }).catch(() => {});
      } else {
        toast.error(`Lock failed: ${data.error}`, { id: toastId });
      }
    } catch {
      toast.error('Network error during lock.', { id: toastId });
    } finally {
      setSaving(false);
    }
  }

  function startEditUser(u: AppUser) {
    setEditingUserId(u.uid);
    setEditEmail(u.email);
    setEditPassword('');
  }

  async function handleSaveUser() {
    if (!editingUserId) return;
    if (!editEmail && !editPassword) { toast.error('Enter an email or password to update'); return; }
    if (editPassword && editPassword.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    setSavingUser(true);
    const tid = toast.loading('Saving…');
    try {
      const body: Record<string, string> = { uid: editingUserId };
      if (editEmail) body.email = editEmail;
      if (editPassword) body.password = editPassword;
      const res = await fetch('/api/admin/update-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Updated ${data.updated.join(' & ')} for user`, { id: tid });
      setUsers((prev) => prev.map((u) => u.uid === editingUserId ? { ...u, email: editEmail || u.email } : u));
      setEditingUserId(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Update failed', { id: tid });
    } finally {
      setSavingUser(false);
    }
  }

  async function handleCreateUser() {
    if (!newUsername || !newEmail || !newPassword) return;
    try {
      const res = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, password: newPassword, username: newUsername, role: 'user' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Account created for ${newUsername}`);
      setNewUsername(''); setNewEmail(''); setNewPassword('');
      setUsers(await getAllUsers());
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Unknown error');
    }
  }

  async function initAllUsers() {
    const toastId = toast.loading('Creating accounts…');
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
    toast.success(`Done! ${created} users created. Default password: changeme123`, { id: toastId });
    setUsers(await getAllUsers());
  }

  async function generateDailyRecap(tournamentId: string, round: number) {
    setRecapPickingId(null);
    setRecapError(null);
    setGeneratingRecap(true);
    const toastId = toast.loading(`Generating Round ${round} recap…`);
    try {
      const res = await fetch('/api/cron/daily-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: process.env.NEXT_PUBLIC_ADMIN_SEED_SECRET, tournamentId, round }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(`Recap generated for ${data.summary?.dayLabel ?? `Round ${round}`}!`, { id: toastId });
        setRecapError(null);
      } else {
        const msg = data.error ?? 'Unknown error';
        toast.error(`Failed: ${msg}`, { id: toastId });
        setRecapError({ tournamentId, msg });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error';
      toast.error('Network error generating recap.', { id: toastId });
      setRecapError({ tournamentId, msg });
    } finally {
      setGeneratingRecap(false);
    }
  }

  async function seedHistoricalData() {
    setSeeding(true);
    const toastId = toast.loading('Importing historical data…');
    try {
      const res = await fetch('/api/admin/seed-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': process.env.NEXT_PUBLIC_CRON_SECRET ?? '' },
        body: JSON.stringify({ overwrite: false }),
      });
      const data = await res.json();
      if (res.ok) toast.success(`Imported ${data.imported} tournaments (${data.skipped} already existed).`, { id: toastId });
      else toast.error(`Seed failed: ${data.error}`, { id: toastId });
    } catch {
      toast.error('Network error during seed.', { id: toastId });
    } finally {
      setSeeding(false);
    }
  }

  async function refreshAlltimeStats() {
    setRefreshingStats(true);
    const toastId = toast.loading('Computing all-time golfer stats…');
    try {
      const res = await fetch('/api/admin/refresh-alltime-stats', { method: 'POST' });
      const data = await res.json();
      if (res.ok) toast.success(`All-time stats updated: ${data.golfers} golfers, ${data.performances} performances.`, { id: toastId, duration: 5000 });
      else toast.error(`Failed: ${data.error}`, { id: toastId });
    } catch {
      toast.error('Network error.', { id: toastId });
    } finally {
      setRefreshingStats(false);
    }
  }

  async function handleCreateSeason() {
    const allSlots = [...stdSlots, ...extraSlots];
    for (const slot of allSlots) {
      if (!slot.espnEventId.trim()) {
        toast.error(`ESPN Event ID required for ${slot.name}`);
        return;
      }
      if (!slot.startDate.trim()) {
        toast.error(`Start date required for ${slot.name}`);
        return;
      }
    }
    if (!confirm(`Create ${newSeasonYear} season with ${allSlots.length} tournament(s)?\n\nThis will overwrite any existing tournaments with the same IDs.`)) return;

    setCreatingSeason(true);
    const toastId = toast.loading(`Creating ${newSeasonYear} season…`);
    try {
      const newTournaments: import('@/lib/types').Tournament[] = allSlots.map(slot => ({
        id: slot.id,
        name: slot.name,
        shortName: slot.shortName,
        year: newSeasonYear,
        startDate: slot.startDate,
        liveScoresStart: slot.liveScoresStart || undefined,
        draftDate: slot.draftDate || undefined,
        espnEventId: slot.espnEventId,
        fieldSize: slot.fieldSize,
        maxPicks: slot.maxPicks,
        status: 'upcoming' as const,
        draftOrder: [],
        draftComplete: false,
        cutLine: slot.cutLine,
        sequence: slot.sequence,
      }));
      await createTournamentsBatch(newTournaments);
      toast.success(`${newSeasonYear} season created with ${newTournaments.length} tournament(s)!`, { id: toastId, duration: 6000 });
      const ts = await getAllTournaments();
      ts.sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99));
      setTournaments(ts);
      setExtraSlots([]);
      setStdSlots(makeDefaultSlots());
      setSeasonSetupOpen(false);
    } catch (err) {
      toast.error(`Failed: ${String(err)}`, { id: toastId });
    } finally {
      setCreatingSeason(false);
    }
  }

  if (loading || !appUser) {
    return (
      <div className="min-h-screen page"><Navigation />
        <div className="flex items-center justify-center h-64 font-bebas text-xl tracking-widest animate-pulse" style={{ color: '#C9A227' }}>LOADING…</div>
      </div>
    );
  }

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
            {tournaments.map((t) => {
              const seqIdx = TOURNAMENT_SEQUENCE.indexOf(t.id);
              const isFirst = seqIdx === 0;
              const prevTournament = seqIdx > 0 ? tournaments.find((x) => x.id === TOURNAMENT_SEQUENCE[seqIdx - 1]) : null;
              const statusColor = t.status === 'active' ? '#4ade80' : t.status === 'drafting' ? '#C9A227' : t.status === 'completed' ? '#475569' : '#e2e8f0';

              return (
                <div key={t.id} className="card">
                  {/* Tournament info — always full width */}
                  <div className="mb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-white">{t.name}</h3>
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(255,255,255,0.08)', color: statusColor }}>
                        {t.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-slate-400 text-xs mt-1">
                      📅 {t.startDate}
                      {t.draftDate && <span className="text-slate-500"> · Draft: {t.draftDate}</span>}
                    </p>
                    <p className="text-slate-500 text-xs mt-0.5">
                      ESPN ID: <span className="font-mono" style={{ color: t.espnEventId ? '#4ade80' : '#f87171' }}>{t.espnEventId || '⚠ not set'}</span>
                      {' · '}Draft order: <span style={{ color: t.draftOrder?.length ? '#4ade80' : '#f87171' }}>{t.draftOrder?.length ? `${t.draftOrder.length} users ✓` : '⚠ not set'}</span>
                    </p>
                  </div>

                  {/* Action buttons — wrap on mobile */}
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={() => startEdit(t)} className="btn-secondary text-xs py-1.5 px-3">
                      ✏️ Edit
                    </button>

                    {t.status === 'upcoming' && t.draftOrder?.length > 0 && (
                      <button onClick={() => openDraft(t)} disabled={saving}
                        className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                        style={{ background: '#C9A227', color: '#0D1F38' }}>
                        Open Draft
                      </button>
                    )}

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
                        <button onClick={() => setRecapPickingId(recapPickingId === t.id ? null : t.id)}
                          disabled={generatingRecap}
                          className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50">
                          {generatingRecap ? '⏳…' : '📋 Recap'}
                        </button>
                      </>
                    )}
                    {t.status === 'completed' && (
                      <button onClick={() => setRecapPickingId(recapPickingId === t.id ? null : t.id)}
                        disabled={generatingRecap}
                        className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-50">
                        {generatingRecap ? '⏳…' : '📋 Recap'}
                      </button>
                    )}
                    {/* Round picker — shown after clicking Recap */}
                    {recapPickingId === t.id && (
                      <div className="w-full mt-1 flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-slate-400">Which round?</span>
                        {[1, 2, 3, 4].map((r) => (
                          <button key={r} onClick={() => generateDailyRecap(t.id, r)}
                            className="text-xs py-1 px-2.5 rounded-lg font-bold transition-all"
                            style={{ background: 'rgba(201,162,39,0.15)', color: '#C9A227', border: '1px solid rgba(201,162,39,0.4)' }}>
                            R{r}
                          </button>
                        ))}
                        <button onClick={() => setRecapPickingId(null)}
                          className="text-xs text-slate-500 hover:text-slate-300 px-1">✕</button>
                      </div>
                    )}
                    {/* Inline error — visible even when toasts are blocked by Dynamic Island / tab bar */}
                    {recapError?.tournamentId === t.id && (
                      <div className="w-full mt-1 rounded-lg px-3 py-2 text-xs font-mono break-all"
                        style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.4)' }}>
                        {recapError.msg}
                        <button onClick={() => setRecapError(null)} className="ml-2 opacity-60 hover:opacity-100">✕</button>
                      </div>
                    )}

                    <Link href={`/admin/rosters/${t.id}`} className="btn-secondary text-xs py-1.5 px-3">
                      👥 Rosters
                    </Link>

                    {/* Reed Rule toggle */}
                    <button
                      onClick={() => toggleReedRule(t.id)}
                      disabled={reedRuleSaving === t.id}
                      className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40 flex items-center gap-1.5"
                      style={reedRuleStates[t.id]
                        ? { background: 'rgba(239,68,68,0.2)', color: '#f87171', border: '1px solid rgba(239,68,68,0.5)' }
                        : { background: 'rgba(255,255,255,0.06)', color: '#64748b', border: '1px solid rgba(255,255,255,0.1)' }
                      }
                      title={reedRuleStates[t.id] ? 'Reed Rule ACTIVE — click to deactivate' : 'Activate Reed Rule to disqualify team with Patrick Reed'}>
                      🚩 Reed Rule {reedRuleStates[t.id] ? 'ON' : 'OFF'}
                    </button>

                    {/* Emergency picks import — for active tournaments where draft node is missing */}
                    {(t.status === 'active' || t.status === 'drafting') && (
                      <button
                        onClick={() => setImportPicksId(importPicksId === t.id ? null : t.id)}
                        className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all"
                        style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}
                        title="Re-enter picks manually if the draft node is missing from Firebase">
                        ⚡ Re-Enter Picks
                      </button>
                    )}

                    {/* Generate Draft Grades — show once draft is done (draftComplete flag or active/completed status) */}
                    {(t.draftComplete || t.status === 'active' || t.status === 'completed') && (
                      <button
                        disabled={saving}
                        onClick={async () => {
                          setSaving(true);
                          try {
                            const res = await fetch('/api/ai/draft-grades', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ tournamentId: t.id, force: false }),
                            });
                            const data = await res.json().catch(() => ({}));
                            if (res.ok) {
                              alert(`✅ Grades ${data.cached ? 'loaded from cache' : 'generated'} for ${Array.isArray(data.grades) ? data.grades.length : '?'} teams`);
                            } else {
                              alert(`❌ ${data.error ?? `HTTP ${res.status}`}`);
                            }
                          } catch (e) { alert(`❌ ${e instanceof Error ? e.message : 'Network error'}`); }
                          finally { setSaving(false); }
                        }}
                        className="text-xs py-1.5 px-3 rounded-lg font-bold disabled:opacity-40"
                        style={{ background: 'rgba(139,92,246,0.2)', color: '#c4b5fd', border: '1px solid rgba(139,92,246,0.4)' }}>
                        🎓 Gen Grades
                      </button>
                    )}

                    {(t.status === 'drafting' || t.status === 'active') && (
                      <>
                        <button onClick={() => handleUndoLastPick(t)} disabled={saving}
                          className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                          style={{ background: 'rgba(251,191,36,0.10)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}
                          title="Remove only the last pick — everything else stays">
                          ↩ Undo Last Pick
                        </button>
                        <button onClick={() => handleClearPicks(t)} disabled={saving}
                          className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                          style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                          ↺ Clear All Picks
                        </button>
                      </>
                    )}
                    {t.status !== 'upcoming' && (
                      <button onClick={() => handleResetDraft(t)} disabled={saving}
                        className="text-xs py-1.5 px-3 rounded-lg font-bold transition-all disabled:opacity-40"
                        style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }}>
                        🗑 Full Reset
                      </button>
                    )}
                  </div>

                  {/* Emergency picks import form */}
                  {importPicksId === t.id && (
                    <div className="mt-4 border-t border-yellow-800 pt-4 space-y-3">
                      <div className="flex items-start gap-2">
                        <span className="text-yellow-400 text-lg">⚡</span>
                        <div>
                          <p className="text-yellow-300 text-sm font-bold">Re-Enter Draft Picks</p>
                          <p className="text-slate-400 text-xs">Enter {t.maxPicks || 5} player names per user (one per line). Player names are matched by name — exact spelling from ESPN preferred but not required.</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {users.map((u) => (
                          <div key={u.uid}>
                            <label className="text-xs font-bold text-slate-300 block mb-1">{u.username}</label>
                            <textarea
                              rows={t.maxPicks || 5}
                              value={importPickInputs[u.uid] ?? ''}
                              onChange={(e) => setImportPickInputs((prev) => ({ ...prev, [u.uid]: e.target.value }))}
                              placeholder={`Player 1\nPlayer 2\nPlayer 3\nPlayer 4\nPlayer 5`}
                              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-yellow-600 resize-none"
                            />
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleImportPicks(t)} disabled={saving}
                          className="text-sm py-2 px-4 rounded-lg font-bold transition-all disabled:opacity-40"
                          style={{ background: '#C9A227', color: '#0D1F38' }}>
                          {saving ? 'Importing…' : 'Import Picks'}
                        </button>
                        <button onClick={() => { setImportPicksId(null); setImportPickInputs({}); }}
                          className="btn-secondary text-sm">Cancel</button>
                      </div>
                    </div>
                  )}

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

            {/* Lock scores / seed section */}
            <div className="card mt-6">
              <h3 className="font-bebas text-lg tracking-wider text-white mb-3">Historical Data</h3>
              <p className="text-slate-400 text-sm mb-3">Import pick history from 2019–2025 for the History page.</p>
              <div className="flex gap-2 flex-wrap">
                <button onClick={seedHistoricalData} disabled={seeding} className="btn-secondary text-sm disabled:opacity-50">
                  {seeding ? 'Importing…' : '📂 Import Historical Picks'}
                </button>
                <button onClick={refreshAlltimeStats} disabled={refreshingStats} className="btn-secondary text-sm disabled:opacity-50">
                  {refreshingStats ? '⏳ Computing…' : '📊 Refresh All-Time Golfer Stats'}
                </button>
                <button
                  onClick={async () => {
                    const toastId = toast.loading('Tagging 2026 tournaments…');
                    try {
                      const res = await fetch('/api/admin/tag-season-tournaments', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ year: 2026 }),
                      });
                      const data = await res.json();
                      if (res.ok) toast.success(data.message ?? 'Done', { id: toastId });
                      else toast.error(`Failed: ${data.error}`, { id: toastId });
                    } catch {
                      toast.error('Network error.', { id: toastId });
                    }
                  }}
                  className="btn-secondary text-sm">
                  🏷️ Tag 2026 Tournaments
                </button>
              </div>
            </div>

            {/* Season Setup */}
            <div className="card mt-4" style={{ border: '1px solid rgba(0,107,182,0.3)', background: 'rgba(0,107,182,0.04)' }}>
              <button
                className="w-full flex items-center justify-between"
                onClick={() => setSeasonSetupOpen(o => !o)}>
                <h3 className="font-bebas text-lg tracking-wider text-white flex items-center gap-2">
                  <Calendar size={16} className="text-blue-400" /> New Season Setup
                </h3>
                {seasonSetupOpen
                  ? <ChevronDown size={14} style={{ color: 'rgba(148,163,184,0.5)' }} />
                  : <ChevronRight size={14} style={{ color: 'rgba(148,163,184,0.5)' }} />}
              </button>

              {!seasonSetupOpen && (
                <p className="text-slate-400 text-sm mt-2">Configure the tournament schedule for a new season.</p>
              )}

              {seasonSetupOpen && (
                <div className="mt-4 space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="text-sm text-slate-300 font-semibold">Season Year</label>
                    <input
                      type="number"
                      value={newSeasonYear}
                      onChange={e => setNewSeasonYear(+e.target.value)}
                      className="input w-24 text-sm"
                      min={2026}
                      max={2040}
                    />
                    <span className="text-xs text-slate-500">Tournaments with the same IDs will be updated.</span>
                  </div>

                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(148,163,184,0.4)' }}>
                      Standard Tournaments
                    </p>
                    {stdSlots.map((slot, i) => (
                      <div key={slot.id} className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-slate-500">{slot.sequence}.</span>
                          <span className="text-sm font-semibold text-white">{slot.name}</span>
                          <span className="text-xs text-slate-500">· max {slot.maxPicks} picks</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="text-xs text-slate-400 block mb-0.5">ESPN Event ID *</label>
                            <input
                              type="text"
                              value={slot.espnEventId}
                              onChange={e => setStdSlots(prev => prev.map((s, j) => j === i ? { ...s, espnEventId: e.target.value } : s))}
                              placeholder="e.g. 401900000"
                              className="input text-xs w-full font-mono"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-slate-400 block mb-0.5">Start Date *</label>
                            <input
                              type="text"
                              value={slot.startDate}
                              onChange={e => setStdSlots(prev => prev.map((s, j) => j === i ? { ...s, startDate: e.target.value } : s))}
                              placeholder={`April 9–12, ${newSeasonYear}`}
                              className="input text-xs w-full"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-slate-400 block mb-0.5">Draft Date</label>
                            <input
                              type="text"
                              value={slot.draftDate}
                              onChange={e => setStdSlots(prev => prev.map((s, j) => j === i ? { ...s, draftDate: e.target.value } : s))}
                              placeholder={`April 5, ${newSeasonYear}`}
                              className="input text-xs w-full"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-slate-400 block mb-0.5">Live Scores Start (UTC)</label>
                            <input
                              type="text"
                              value={slot.liveScoresStart}
                              onChange={e => setStdSlots(prev => prev.map((s, j) => j === i ? { ...s, liveScoresStart: e.target.value } : s))}
                              placeholder={`${newSeasonYear}-04-10T11:00:00Z`}
                              className="input text-xs w-full font-mono"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {extraSlots.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgba(148,163,184,0.4)' }}>
                        Extra Tournaments
                      </p>
                      {extraSlots.map((slot, i) => (
                        <div key={i} className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-white">{slot.name || 'New Tournament'}</span>
                            <button onClick={() => setExtraSlots(prev => prev.filter((_, j) => j !== i))} className="text-xs" style={{ color: '#f87171' }}>Remove</button>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <div>
                              <label className="text-xs text-slate-400 block mb-0.5">Tournament Name *</label>
                              <input
                                type="text"
                                value={slot.name}
                                onChange={e => {
                                  const name = e.target.value;
                                  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                                  const id = slug ? `${slug}-${newSeasonYear}` : `extra-${i + 1}-${newSeasonYear}`;
                                  setExtraSlots(prev => prev.map((s, j) => j === i ? { ...s, name, id } : s));
                                }}
                                placeholder="e.g. The Genesis Invitational"
                                className="input text-xs w-full"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-slate-400 block mb-0.5">Short Name</label>
                              <input
                                type="text"
                                value={slot.shortName}
                                onChange={e => setExtraSlots(prev => prev.map((s, j) => j === i ? { ...s, shortName: e.target.value.toUpperCase() } : s))}
                                placeholder="GENESIS"
                                className="input text-xs w-full"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-slate-400 block mb-0.5">ESPN Event ID *</label>
                              <input
                                type="text"
                                value={slot.espnEventId}
                                onChange={e => setExtraSlots(prev => prev.map((s, j) => j === i ? { ...s, espnEventId: e.target.value } : s))}
                                placeholder="e.g. 401900000"
                                className="input text-xs w-full font-mono"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-slate-400 block mb-0.5">Start Date *</label>
                              <input
                                type="text"
                                value={slot.startDate}
                                onChange={e => setExtraSlots(prev => prev.map((s, j) => j === i ? { ...s, startDate: e.target.value } : s))}
                                placeholder={`Feb 12–15, ${newSeasonYear}`}
                                className="input text-xs w-full"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-slate-400 block mb-0.5">Draft Date</label>
                              <input
                                type="text"
                                value={slot.draftDate}
                                onChange={e => setExtraSlots(prev => prev.map((s, j) => j === i ? { ...s, draftDate: e.target.value } : s))}
                                placeholder={`Feb 8, ${newSeasonYear}`}
                                className="input text-xs w-full"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-slate-400 block mb-0.5">Max Picks</label>
                              <input
                                type="number"
                                value={slot.maxPicks}
                                onChange={e => setExtraSlots(prev => prev.map((s, j) => j === i ? { ...s, maxPicks: +e.target.value } : s))}
                                className="input text-xs w-full"
                                min={1} max={8}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => setExtraSlots(prev => [...prev, {
                        id: `extra-${prev.length + 1}-${newSeasonYear}`,
                        name: '', shortName: '', fieldSize: 100, maxPicks: 5, cutLine: 65,
                        sequence: STANDARD_TOURNAMENTS.length + prev.length + 1,
                        espnEventId: '', startDate: '', draftDate: '', liveScoresStart: '',
                      }])}
                      className="btn-secondary text-xs">
                      <Plus size={12} className="inline mr-1" /> Add Extra Tournament
                    </button>
                    <button
                      onClick={handleCreateSeason}
                      disabled={creatingSeason}
                      className="text-sm py-2 px-4 rounded-lg font-bold transition-all disabled:opacity-40"
                      style={{ background: '#1B3A9E', color: '#fff' }}>
                      {creatingSeason ? '⏳ Creating…' : `Create ${newSeasonYear} Season`}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* End Season */}
            <div className="card mt-4" style={{ border: '1px solid rgba(201,162,39,0.3)', background: 'rgba(201,162,39,0.05)' }}>
              <h3 className="font-bebas text-lg tracking-wider text-white mb-1 flex items-center gap-2">
                <Trophy size={16} className="text-yellow-400" /> End 2026 Season
              </h3>
              <p className="text-slate-400 text-sm mb-3">
                Locks final standings, computes draft analytics, and generates an AI season recap.
                Run after The Open scores are locked. Safe to re-run with <code className="text-yellow-300">force:true</code>.
              </p>
              <div className="flex gap-2 flex-wrap">
                <button
                  disabled={saving}
                  onClick={async () => {
                    if (!confirm('End the 2026 season?\n\nThis will compute season analytics and generate an AI recap. If an archive already exists you\'ll be prompted to overwrite.')) return;
                    setSaving(true);
                    const toastId = toast.loading('Computing season analytics…');
                    try {
                      let res = await fetch('/api/admin/end-season', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ year: 2026, lockedBy: appUser?.username }),
                      });
                      if (res.status === 409) {
                        if (!confirm('Season archive already exists. Overwrite with fresh data?')) {
                          toast.dismiss(toastId);
                          setSaving(false);
                          return;
                        }
                        res = await fetch('/api/admin/end-season', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ year: 2026, lockedBy: appUser?.username, force: true }),
                        });
                      }
                      const data = await res.json();
                      if (res.ok) {
                        toast.success(`🏆 Season archived! Champion: ${data.champion?.username}. ${data.hasRecap ? 'AI recap generated.' : 'No API key — add OPENAI_API_KEY for recap.'}`, { id: toastId, duration: 6000 });
                      } else {
                        toast.error(`Failed: ${data.error}`, { id: toastId });
                      }
                    } catch {
                      toast.error('Network error.', { id: toastId });
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className="text-sm py-2 px-4 rounded-lg font-bold transition-all disabled:opacity-40"
                  style={{ background: '#C9A227', color: '#0D1F38' }}>
                  {saving ? '⏳ Computing…' : '🏆 End Season & Archive'}
                </button>
                <button
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    const toastId = toast.loading('Regenerating AI recap…');
                    try {
                      const res = await fetch('/api/admin/end-season', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ year: 2026, lockedBy: appUser?.username, recapOnly: true }),
                      });
                      const data = await res.json();
                      if (res.ok) {
                        toast.success('AI recap regenerated!', { id: toastId });
                      } else {
                        toast.error(`Failed: ${data.error}`, { id: toastId });
                      }
                    } catch {
                      toast.error('Network error.', { id: toastId });
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className="btn-secondary text-sm disabled:opacity-40">
                  {saving ? '⏳…' : '✨ Regen AI Recap'}
                </button>
              </div>
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
                      <th className="text-left py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <React.Fragment key={u.uid}>
                        <tr className="border-b border-slate-700/50">
                          <td className="py-2 font-medium text-white">{u.username}</td>
                          <td className="py-2 text-slate-400 text-xs">{u.email}</td>
                          <td className="py-2">
                            <span className={`text-xs px-1.5 py-0.5 rounded ${u.role === 'admin' ? 'bg-yellow-700 text-yellow-100' : 'bg-slate-700 text-slate-300'}`}>
                              {u.role}
                            </span>
                          </td>
                          <td className="py-2 text-right">
                            <button
                              onClick={() => editingUserId === u.uid ? setEditingUserId(null) : startEditUser(u)}
                              className="text-xs px-2 py-1 rounded text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
                              {editingUserId === u.uid ? 'Cancel' : '✏️ Edit'}
                            </button>
                          </td>
                        </tr>
                        {editingUserId === u.uid && (
                          <tr key={`${u.uid}-edit`} className="border-b border-slate-700/50 bg-slate-800/40">
                            <td colSpan={4} className="py-3 px-2">
                              <div className="flex flex-wrap gap-2 items-end">
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">New Email</label>
                                  <input
                                    type="email"
                                    value={editEmail}
                                    onChange={(e) => setEditEmail(e.target.value)}
                                    className="input text-sm py-1.5 w-48"
                                    placeholder="email@example.com"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">New Password</label>
                                  <input
                                    type="password"
                                    value={editPassword}
                                    onChange={(e) => setEditPassword(e.target.value)}
                                    className="input text-sm py-1.5 w-40"
                                    placeholder="leave blank to keep"
                                  />
                                </div>
                                <button
                                  onClick={handleSaveUser}
                                  disabled={savingUser}
                                  className="btn-primary text-xs py-1.5 px-3 disabled:opacity-40">
                                  {savingUser ? 'Saving…' : 'Save'}
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
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
