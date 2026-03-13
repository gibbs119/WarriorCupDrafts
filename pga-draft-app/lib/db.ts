import { ref, get, set, update, push, onValue, off, runTransaction, DatabaseReference } from 'firebase/database';
import { db } from './firebase';
import type { Tournament, DraftState, DraftPick, AppUser, Player, WDReplacement, RosterEdit } from './types';
import { TOURNAMENTS, USERS } from './constants';

// ─── Tournaments ─────────────────────────────────────────────────────────────

export async function initializeTournamentsIfNeeded() {
  const snap = await get(ref(db, 'tournaments'));
  if (snap.exists()) return;

  const updates: Record<string, unknown> = {};
  for (const t of TOURNAMENTS) {
    updates[`tournaments/${t.id}`] = t;
  }
  await update(ref(db), updates);
}

export async function getTournament(id: string): Promise<Tournament | null> {
  const snap = await get(ref(db, `tournaments/${id}`));
  return snap.exists() ? (snap.val() as Tournament) : null;
}

export async function getAllTournaments(): Promise<Tournament[]> {
  const snap = await get(ref(db, 'tournaments'));
  if (!snap.exists()) return [];
  return Object.values(snap.val() as Record<string, Tournament>);
}

export function subscribeTournament(
  id: string,
  callback: (t: Tournament | null) => void
): () => void {
  const r = ref(db, `tournaments/${id}`);
  onValue(r, (snap) => callback(snap.exists() ? snap.val() : null));
  return () => off(r);
}

export async function updateTournament(id: string, data: Partial<Tournament>) {
  await update(ref(db, `tournaments/${id}`), data);
}

// ─── Draft ───────────────────────────────────────────────────────────────────

export async function getDraftState(tournamentId: string): Promise<DraftState | null> {
  const snap = await get(ref(db, `drafts/${tournamentId}`));
  return snap.exists() ? (snap.val() as DraftState) : null;
}

export function subscribeDraftState(
  tournamentId: string,
  callback: (state: DraftState | null) => void
): () => void {
  const r = ref(db, `drafts/${tournamentId}`);
  onValue(r, (snap) => callback(snap.exists() ? snap.val() : null));
  return () => off(r);
}

export async function initializeDraft(tournamentId: string, snakeDraftOrder: string[]) {
  const state: DraftState = {
    tournamentId,
    picks: [],
    currentPickIndex: 0,
    snakeDraftOrder,
    status: 'open',
  };
  await set(ref(db, `drafts/${tournamentId}`), state);
}

export async function submitPick(
  tournamentId: string,
  pick: DraftPick,
  nextPickIndex: number,
  isDraftComplete: boolean
) {
  // Use runTransaction to atomically append the pick — prevents two simultaneous
  // picks from clobbering each other via a read-then-write race condition.
  await runTransaction(ref(db, `drafts/${tournamentId}`), (current) => {
    if (!current) return current; // abort if node doesn't exist yet
    const existingPicks: DraftPick[] = Array.isArray(current.picks) ? current.picks : [];
    return {
      ...current,
      picks: [...existingPicks, pick],
      currentPickIndex: nextPickIndex,
      status: isDraftComplete ? 'complete' : 'open',
    };
  });

  if (isDraftComplete) {
    await updateTournament(tournamentId, { draftComplete: true, status: 'active' });
  }
}

// ─── Players / Leaderboard ───────────────────────────────────────────────────

export async function savePlayers(tournamentId: string, players: Record<string, Player>) {
  // Use a flattened update() instead of set() to avoid overwriting concurrent writes
  // from other clients who may be refreshing scores at the same time.
  const updates: Record<string, Player> = {};
  for (const [id, player] of Object.entries(players)) {
    updates[`players/${tournamentId}/${id}`] = player;
  }
  await update(ref(db), updates);
}

export function subscribePlayers(
  tournamentId: string,
  callback: (players: Record<string, Player>) => void
): () => void {
  const r = ref(db, `players/${tournamentId}`);
  onValue(r, (snap) => callback(snap.exists() ? snap.val() : {}));
  return () => off(r);
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function getUserByUid(uid: string): Promise<AppUser | null> {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? (snap.val() as AppUser) : null;
}

export async function getAllUsers(): Promise<AppUser[]> {
  const snap = await get(ref(db, 'users'));
  if (!snap.exists()) return [];
  return Object.values(snap.val() as Record<string, AppUser>);
}

export async function setUser(uid: string, user: AppUser) {
  await set(ref(db, `users/${uid}`), user);
}

// ─── Results / History ───────────────────────────────────────────────────────

export async function saveResults(tournamentId: string, results: unknown) {
  await set(ref(db, `results/${tournamentId}`), results);
}

export async function getResults(tournamentId: string): Promise<unknown> {
  const snap = await get(ref(db, `results/${tournamentId}`));
  return snap.exists() ? snap.val() : null;
}

export async function getAllResults(): Promise<Record<string, unknown>> {
  const snap = await get(ref(db, 'results'));
  return snap.exists() ? snap.val() : {};
}
// ─── Draft Order from Previous Tournament Results ────────────────────────────

/**
 * Returns user UIDs ordered by their finishing rank in the given tournament.
 * Rank 1 (winner) is first in the returned array.
 * Used to auto-set draft order for the next tournament.
 */
export async function getDraftOrderFromResults(
  tournamentId: string
): Promise<string[] | null> {
  const snap = await get(ref(db, `results/${tournamentId}/rankedOrder`));
  return snap.exists() ? (snap.val() as string[]) : null;
}

/**
 * Saves the final ranked order (array of UIDs, rank-1 first) for a tournament.
 * Called when admin marks a tournament as Final.
 */
export async function saveRankedOrder(tournamentId: string, rankedUids: string[]) {
  await set(ref(db, `results/${tournamentId}/rankedOrder`), rankedUids);
}

// ─── WD Replacements ─────────────────────────────────────────────────────────

/** User submits a WD replacement request. */
export async function submitWDRequest(
  tournamentId: string,
  request: WDReplacement
): Promise<void> {
  const key = `${request.userId}-${Date.now()}`;
  await update(ref(db, `wdRequests/${tournamentId}/${key}`), request);
}

/** Real-time subscription to all WD requests for a tournament (admin use). */
export function subscribeWDRequests(
  tournamentId: string,
  callback: (requests: Record<string, WDReplacement>) => void
): () => void {
  const r = ref(db, `wdRequests/${tournamentId}`);
  onValue(r, (snap) => callback(snap.exists() ? snap.val() : {}));
  return () => off(r);
}

/** Real-time subscription to WD requests for a specific user. */
export function subscribeMyWDRequests(
  tournamentId: string,
  userId: string,
  callback: (requests: Record<string, WDReplacement>) => void
): () => void {
  const r = ref(db, `wdRequests/${tournamentId}`);
  onValue(r, (snap) => {
    if (!snap.exists()) { callback({}); return; }
    const all = snap.val() as Record<string, WDReplacement>;
    const mine = Object.fromEntries(
      Object.entries(all).filter(([, v]) => v.userId === userId)
    );
    callback(mine);
  });
  return () => off(r);
}

/**
 * Admin approves a WD request: swaps the pick in the draft picks array
 * and records the approval.
 */
export async function approveWDRequest(
  tournamentId: string,
  requestKey: string,
  request: WDReplacement,
  adminUid: string,
  adminName: string
): Promise<void> {
  // Load current picks
  const snap = await get(ref(db, `drafts/${tournamentId}/picks`));
  const picks: DraftPick[] = snap.exists() ? snap.val() : [];

  // Swap the dropped player for the replacement in this user's picks
  const updatedPicks = picks.map((p) => {
    if (
      p.userId === request.userId &&
      (p.playerId === request.droppedPlayerId || p.playerName === request.droppedPlayerName)
    ) {
      return {
        ...p,
        playerId: request.replacementPlayerId,
        playerName: request.replacementPlayerName,
        replacedFrom: { id: p.playerId, name: p.playerName },
        replacedAt: Date.now(),
      };
    }
    return p;
  });

  const updates: Record<string, unknown> = {};
  updates[`drafts/${tournamentId}/picks`] = updatedPicks;
  updates[`wdRequests/${tournamentId}/${requestKey}`] = {
    ...request,
    status: 'approved',
    approvedAt: Date.now(),
    approvedBy: adminName,
  };
  updates[`rosterEdits/${tournamentId}/${requestKey}`] = {
    editedBy: adminUid,
    editedByName: adminName,
    editedAt: Date.now(),
    userId: request.userId,
    username: request.username,
    oldPickId: request.droppedPlayerId,
    oldPickName: request.droppedPlayerName,
    newPickId: request.replacementPlayerId,
    newPickName: request.replacementPlayerName,
    reason: `WD replacement approved`,
  } satisfies RosterEdit;

  await update(ref(db), updates);
}

/** Admin denies a WD request. */
export async function denyWDRequest(
  tournamentId: string,
  requestKey: string,
  request: WDReplacement,
  adminName: string,
  note?: string
): Promise<void> {
  await update(ref(db, `wdRequests/${tournamentId}/${requestKey}`), {
    ...request,
    status: 'denied',
    approvedAt: Date.now(),
    approvedBy: adminName,
    note,
  });
}

// ─── Admin Roster Edit ────────────────────────────────────────────────────────

/**
 * Admin directly swaps one player for another in any user's roster.
 * Records an audit trail entry.
 */
export async function adminEditRoster(
  tournamentId: string,
  targetUserId: string,
  targetUsername: string,
  oldPickId: string,
  oldPickName: string,
  newPickId: string,
  newPickName: string,
  adminUid: string,
  adminName: string,
  reason?: string
): Promise<void> {
  const snap = await get(ref(db, `drafts/${tournamentId}/picks`));
  const picks: DraftPick[] = snap.exists() ? snap.val() : [];

  const updatedPicks = picks.map((p) => {
    if (
      p.userId === targetUserId &&
      (p.playerId === oldPickId || p.playerName === oldPickName)
    ) {
      return {
        ...p,
        playerId: newPickId,
        playerName: newPickName,
        replacedFrom: { id: p.playerId, name: p.playerName },
        replacedAt: Date.now(),
        replacedByAdmin: adminName,
      };
    }
    return p;
  });

  const editKey = `${targetUserId}-${Date.now()}`;
  const edit: RosterEdit = {
    editedBy: adminUid,
    editedByName: adminName,
    editedAt: Date.now(),
    userId: targetUserId,
    username: targetUsername,
    oldPickId,
    oldPickName,
    newPickId,
    newPickName,
    reason,
  };

  const updates: Record<string, unknown> = {};
  updates[`drafts/${tournamentId}/picks`] = updatedPicks;
  updates[`rosterEdits/${tournamentId}/${editKey}`] = edit;

  await update(ref(db), updates);
}

/** Subscribe to roster edit log for a tournament (admin). */
export function subscribeRosterEdits(
  tournamentId: string,
  callback: (edits: Record<string, RosterEdit>) => void
): () => void {
  const r = ref(db, `rosterEdits/${tournamentId}`);
  onValue(r, (snap) => callback(snap.exists() ? snap.val() : {}));
  return () => off(r);
}

// ─── Draft Reset (Admin) ──────────────────────────────────────────────────────

/**
 * Completely resets a draft — deletes picks, resets status to upcoming.
 * Admin only. Allows re-opening the draft room from scratch.
 */
export async function resetDraft(tournamentId: string): Promise<void> {
  const updates: Record<string, unknown> = {};
  updates[`drafts/${tournamentId}`] = null;           // wipe all picks
  updates[`tournaments/${tournamentId}/status`] = 'upcoming';
  updates[`tournaments/${tournamentId}/draftComplete`] = false;
  updates[`wdRequests/${tournamentId}`] = null;        // clear WD requests
  updates[`rosterEdits/${tournamentId}`] = null;       // clear edit log
  await update(ref(db), updates);
}

/**
 * Resets only the picks but keeps the draft room open — useful to undo a bad pick.
 */
export async function clearDraftPicks(tournamentId: string): Promise<void> {
  const snap = await get(ref(db, `drafts/${tournamentId}`));
  if (!snap.exists()) return;
  await update(ref(db, `drafts/${tournamentId}`), {
    picks: [],
    currentPickIndex: 0,
    status: 'open',
  });
  await updateTournament(tournamentId, { draftComplete: false });
}

// ─── Round Position Snapshots (for position change arrows in round 2+) ────────

/**
 * Save the end-of-round positions for all players.
 * Called automatically when we detect a new round has begun.
 * Stored at: roundPositions/{tournamentId}/round{N}  →  { playerId: position }
 */
export async function saveRoundPositionSnapshot(
  tournamentId: string,
  round: number,
  positions: Record<string, number | null>
): Promise<void> {
  await set(ref(db, `roundPositions/${tournamentId}/round${round}`), positions);
}

/**
 * Get the saved end-of-round positions for a given round.
 * Returns null if no snapshot exists yet.
 */
export async function getRoundPositionSnapshot(
  tournamentId: string,
  round: number
): Promise<Record<string, number | null> | null> {
  const snap = await get(ref(db, `roundPositions/${tournamentId}/round${round}`));
  return snap.exists() ? (snap.val() as Record<string, number | null>) : null;
}

// ─── Hourly Score Snapshots (for Trend graph) ─────────────────────────────────

export interface TrendSnapshot {
  timestamp: number;          // Unix ms
  hour: string;               // "Thu 8AM", "Thu 9AM" etc for display
  scores: Record<string, number>; // userId → top3Score (9999 = not yet playing)
}

/**
 * Save one hourly snapshot. Key = ISO hour string e.g. "2026-03-12T14" (UTC)
 * Only saves if at least one team has a live score (not all 9999).
 */
export async function saveTrendSnapshot(
  tournamentId: string,
  snapshot: TrendSnapshot
): Promise<void> {
  const key = new Date(snapshot.timestamp).toISOString().slice(0, 13); // "2026-03-12T14"
  await set(ref(db, `trendSnapshots/${tournamentId}/${key}`), snapshot);
}

/**
 * Load all trend snapshots for a tournament, sorted chronologically.
 */
export async function getTrendSnapshots(tournamentId: string): Promise<TrendSnapshot[]> {
  const snap = await get(ref(db, `trendSnapshots/${tournamentId}`));
  if (!snap.exists()) return [];
  const raw = snap.val() as Record<string, TrendSnapshot>;
  return Object.values(raw).sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Round-start team score baseline (for Today's Movers) ────────────────────
// Stored at: roundStartBaseline/{tournamentId}/round{N}
// Shape: { userId: { score: number; rank: number } }

export async function saveRoundStartBaseline(
  tournamentId: string,
  round: number,
  baseline: Record<string, { score: number; rank: number }>
): Promise<void> {
  await set(ref(db, `roundStartBaseline/${tournamentId}/round${round}`), baseline);
}

export async function getRoundStartBaseline(
  tournamentId: string,
  round: number
): Promise<Record<string, { score: number; rank: number }> | null> {
  const snap = await get(ref(db, `roundStartBaseline/${tournamentId}/round${round}`));
  return snap.exists() ? (snap.val() as Record<string, { score: number; rank: number }>) : null;
}
