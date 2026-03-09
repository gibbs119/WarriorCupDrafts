'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import Navigation from '@/components/Navigation';
import { get, ref } from 'firebase/database';
import { db } from '@/lib/firebase';
import { Trophy, Lock, ChevronDown, ChevronRight, Users, Calendar } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamScore {
  userId: string; username: string; top3Score: number; rank: number;
  players?: { playerName: string; points: number; countsInTop3: boolean; positionDisplay: string }[];
}
interface LockedTournament {
  tournamentId: string; tournamentName: string; year: number;
  lockedAt: string; lockedBy: string; teamScores: TeamScore[];
}
interface HistoricalDraft {
  id: string; tournamentId: string; tournamentName: string; year: number;
  users: string[]; picksPerUser: number; hasScores: boolean;
  picksByUser: Record<string, { username: string; picks: { playerName: string }[] }>;
  playerScores?: Record<string, Record<string, number>>;
}
interface TournEntry { key: string; name: string; year: number; locked?: LockedTournament; historical?: HistoricalDraft; }
interface YearGroup  { year: number; tournaments: TournEntry[]; }

const TOURN_ORDER = ['players-championship','masters','pga-championship','us-open','the-open','tour-championship'];
const tSort = (id: string) => { const i = TOURN_ORDER.indexOf(id); return i >= 0 ? i : 99; };
const rankIcon = (r: number) => r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `${r}.`;

export default function HistoryPage() {
  const { appUser, loading } = useAuth();
  const router = useRouter();
  const [yearGroups, setYearGroups] = useState<YearGroup[]>([]);
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const [expandedTourn, setExpandedTourn] = useState<string | null>(null);
  const [expandedPicks, setExpandedPicks] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);
  const [stats, setStats] = useState<{ username: string; wins: number; podiums: number; total: number; count: number }[]>([]);

  useEffect(() => { if (!loading && !appUser) router.push('/'); }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      const [lockedSnap, histSnap] = await Promise.all([
        get(ref(db, 'lockedScores')),
        get(ref(db, 'historicalDrafts')),
      ]);
      const locked: Record<string, LockedTournament> = lockedSnap.exists() ? lockedSnap.val() : {};
      const historical: Record<string, HistoricalDraft> = histSnap.exists() ? histSnap.val() : {};

      const map: Record<string, TournEntry> = {};
      for (const lt of Object.values(locked)) {
        const y = lt.year ?? new Date(lt.lockedAt).getFullYear();
        const k = `${y}-${lt.tournamentId}`;
        map[k] = { key: k, name: lt.tournamentName, year: y, locked: lt };
      }
      for (const hd of Object.values(historical)) {
        const k = `${hd.year}-${hd.tournamentId}`;
        if (!map[k]) map[k] = { key: k, name: hd.tournamentName, year: hd.year };
        map[k].historical = hd;
      }

      const byYear: Record<number, TournEntry[]> = {};
      for (const e of Object.values(map)) {
        (byYear[e.year] ??= []).push(e);
      }
      for (const list of Object.values(byYear)) {
        list.sort((a, b) => tSort(a.locked?.tournamentId ?? a.historical?.tournamentId ?? '')
                          - tSort(b.locked?.tournamentId ?? b.historical?.tournamentId ?? ''));
      }
      const groups: YearGroup[] = Object.entries(byYear)
        .sort(([a],[b]) => +b - +a)
        .map(([y, t]) => ({ year: +y, tournaments: t }));

      setYearGroups(groups);
      if (groups.length) setExpandedYear(groups[0].year);

      // All-time stats from locked scores
      const st: Record<string, { wins: number; podiums: number; total: number; count: number }> = {};
      for (const lt of Object.values(locked)) {
        for (const ts of lt.teamScores ?? []) {
          st[ts.username] ??= { wins:0, podiums:0, total:0, count:0 };
          st[ts.username].total += ts.top3Score;
          st[ts.username].count++;
          if (ts.rank === 1) st[ts.username].wins++;
          if (ts.rank <= 3) st[ts.username].podiums++;
        }
      }
      setStats(Object.entries(st).map(([username, s]) => ({ username, ...s })).sort((a,b) => a.total - b.total));
      setFetching(false);
    }
    load();
  }, [appUser]);

  if (loading || !appUser) return (
    <div className="min-h-screen page"><Navigation />
      <div className="flex items-center justify-center h-64">
        <p className="font-bebas text-xl tracking-widest animate-pulse" style={{color:'#C9A227'}}>LOADING…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen page">
      <Navigation />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[900px] h-64 pointer-events-none"
        style={{background:'radial-gradient(ellipse, rgba(0,107,182,0.1) 0%, transparent 70%)'}} />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="mb-8">
          <p className="text-xs uppercase tracking-widest font-semibold mb-1" style={{color:'rgba(148,163,184,0.5)'}}>All-Time Records</p>
          <h1 className="font-bebas text-4xl tracking-widest text-white flex items-center gap-3">
            <Trophy size={32} style={{color:'#C9A227'}} /> Season History
          </h1>
          <p className="text-sm mt-1" style={{color:'rgba(148,163,184,0.4)'}}>
            2019–present · Picks from historical spreadsheet · Scores auto-locked every Monday at 8 pm ET
          </p>
        </div>

        {fetching ? (
          <div className="text-center py-20 font-bebas text-xl tracking-widest animate-pulse" style={{color:'rgba(148,163,184,0.4)'}}>LOADING HISTORY…</div>
        ) : yearGroups.length === 0 ? (
          <div className="card text-center py-16">
            <p className="text-white font-semibold mb-1">No history yet</p>
            <p className="text-sm" style={{color:'rgba(148,163,184,0.5)'}}>
              Gibbs can import all historical picks from Admin → Users tab.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

            {/* All-time stats */}
            <div className="lg:col-span-1">
              <div className="card sticky top-20">
                <h2 className="font-bebas text-xl tracking-wider text-white mb-4 flex items-center gap-2">
                  <Users size={16} style={{color:'#C9A227'}} /> All-Time Leaders
                </h2>
                {stats.length === 0 ? (
                  <p className="text-sm italic" style={{color:'rgba(148,163,184,0.5)'}}>
                    Stats populate once tournament scores are locked.
                  </p>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      {stats.map((s, i) => {
                        const isMe = s.username === appUser.username;
                        return (
                          <div key={s.username} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
                            style={isMe ? {background:'rgba(0,107,182,0.2)',border:'1px solid rgba(0,107,182,0.4)'} : {background:'rgba(255,255,255,0.04)'}}>
                            <span className="w-5 text-center shrink-0 text-xs" style={{color:'rgba(148,163,184,0.4)'}}>{i+1}.</span>
                            <span className="flex-1 font-semibold text-white truncate">{s.username}</span>
                            <div className="text-right shrink-0">
                              <div className="font-mono font-bold text-sm" style={{color: s.total < 0 ? '#f87171' : '#94a3b8'}}>
                                {s.total > 0 ? '+' : ''}{s.total}
                              </div>
                              <div className="text-xs" style={{color:'rgba(148,163,184,0.35)'}}>
                                {s.count}T · {s.wins}W · {s.podiums}🏅
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-xs pt-2" style={{color:'rgba(148,163,184,0.25)'}}>
                      Score = sum of top-3 player positions across locked tournaments. Lower is better.
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Year groups */}
            <div className="lg:col-span-2 space-y-2">
              {yearGroups.map((yg) => {
                const isYearOpen = expandedYear === yg.year;
                const lockedCount = yg.tournaments.filter(t => t.locked).length;

                return (
                  <div key={yg.year}>
                    <button
                      onClick={() => setExpandedYear(isYearOpen ? null : yg.year)}
                      className="w-full flex items-center justify-between px-4 py-3 rounded-xl mb-1 transition-all"
                      style={{
                        background: isYearOpen ? 'rgba(201,162,39,0.1)' : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${isYearOpen ? 'rgba(201,162,39,0.25)' : 'rgba(255,255,255,0.06)'}`,
                      }}>
                      <div className="flex items-center gap-3">
                        <span className="font-bebas text-2xl tracking-widest text-white">{yg.year}</span>
                        <span className="text-xs" style={{color:'rgba(148,163,184,0.4)'}}>
                          {yg.tournaments.length} event{yg.tournaments.length !== 1 ? 's' : ''}
                          {lockedCount > 0 && <span style={{color:'#C9A227'}}> · {lockedCount} scored</span>}
                        </span>
                      </div>
                      {isYearOpen
                        ? <ChevronDown size={15} style={{color:'rgba(148,163,184,0.4)'}} />
                        : <ChevronRight size={15} style={{color:'rgba(148,163,184,0.4)'}} />}
                    </button>

                    {isYearOpen && (
                      <div className="space-y-2 pl-2">
                        {yg.tournaments.map((tourn) => {
                          const isOpen = expandedTourn === tourn.key;
                          const showPicks = expandedPicks === tourn.key;
                          const hasLocked = !!tourn.locked;
                          const hasHist   = !!tourn.historical;

                          return (
                            <div key={tourn.key} className="card transition-all"
                              style={hasLocked ? {borderColor:'rgba(201,162,39,0.2)'} : {}}>

                              <button className="w-full flex items-center justify-between gap-3 text-left"
                                onClick={() => setExpandedTourn(isOpen ? null : tourn.key)}>
                                <div className="flex items-center gap-2 min-w-0">
                                  <Calendar size={13} style={{color: hasLocked ? '#C9A227' : 'rgba(148,163,184,0.35)', flexShrink:0}} />
                                  <span className="font-semibold text-white truncate text-sm">{tourn.name}</span>
                                  {hasLocked && (
                                    <span className="flex items-center gap-1 shrink-0 text-xs px-1.5 py-0.5 rounded font-semibold"
                                      style={{background:'rgba(201,162,39,0.12)',color:'#C9A227',border:'1px solid rgba(201,162,39,0.25)'}}>
                                      <Lock size={9} /> Scored
                                    </span>
                                  )}
                                  {!hasLocked && hasHist && (
                                    <span className="shrink-0 text-xs px-1.5 py-0.5 rounded"
                                      style={{background:'rgba(255,255,255,0.05)',color:'rgba(148,163,184,0.4)'}}>
                                      Picks only
                                    </span>
                                  )}
                                </div>
                                {isOpen
                                  ? <ChevronDown size={13} style={{color:'rgba(148,163,184,0.4)',flexShrink:0}} />
                                  : <ChevronRight size={13} style={{color:'rgba(148,163,184,0.4)',flexShrink:0}} />}
                              </button>

                              {isOpen && (
                                <div className="mt-4 pt-4" style={{borderTop:'1px solid rgba(255,255,255,0.07)'}}>

                                  {/* Locked final standings */}
                                  {hasLocked && tourn.locked!.teamScores?.length > 0 && (
                                    <div className="mb-4">
                                      <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs font-semibold uppercase tracking-wider" style={{color:'rgba(148,163,184,0.4)'}}>
                                          Final Standings
                                        </p>
                                        <p className="text-xs" style={{color:'rgba(201,162,39,0.5)'}}>
                                          {new Date(tourn.locked!.lockedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                                          {' · '}{tourn.locked!.lockedBy === 'cron-monday-8pm' ? 'auto-locked' : 'manually locked'}
                                        </p>
                                      </div>
                                      <div className="space-y-1">
                                        {[...tourn.locked!.teamScores].sort((a,b) => a.rank-b.rank).map((ts) => {
                                          const isMe = ts.username === appUser.username;
                                          return (
                                            <div key={ts.userId} className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm"
                                              style={isMe ? {background:'rgba(0,107,182,0.2)',border:'1px solid rgba(0,107,182,0.3)'} : {background:'rgba(255,255,255,0.03)'}}>
                                              <span className="w-7 text-center shrink-0">{rankIcon(ts.rank)}</span>
                                              <span className="flex-1 font-semibold text-white">{ts.username}</span>
                                              <span className="font-mono font-bold text-sm shrink-0"
                                                style={{color: ts.top3Score < 0 ? '#f87171' : '#94a3b8'}}>
                                                {ts.top3Score > 0 ? '+' : ''}{ts.top3Score}
                                              </span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    </div>
                                  )}

                                  {/* Historical picks toggle */}
                                  {hasHist && (
                                    <div>
                                      <button
                                        onClick={() => setExpandedPicks(showPicks ? null : tourn.key)}
                                        className="flex items-center gap-1.5 text-xs mb-2 transition-colors hover:text-white"
                                        style={{color:'rgba(148,163,184,0.45)'}}>
                                        {showPicks ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
                                        {hasLocked ? 'View draft picks' : `Draft picks · ${tourn.historical!.picksPerUser} per team`}
                                      </button>

                                      {showPicks && (
                                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                          {tourn.historical!.users.map((username) => {
                                            const data = tourn.historical!.picksByUser[username];
                                            if (!data) return null;
                                            const isMe = username === appUser.username;
                                            const scores = tourn.historical!.playerScores?.[username] ?? {};
                                            return (
                                              <div key={username} className="rounded-lg p-2.5"
                                                style={{
                                                  background: isMe ? 'rgba(0,107,182,0.1)' : 'rgba(255,255,255,0.04)',
                                                  border: `1px solid ${isMe ? 'rgba(0,107,182,0.25)' : 'rgba(255,255,255,0.06)'}`,
                                                }}>
                                                <p className="text-xs font-bold mb-1.5 truncate"
                                                  style={{color: isMe ? '#C9A227' : '#94a3b8'}}>
                                                  {username}
                                                </p>
                                                <ul className="space-y-0.5">
                                                  {data.picks.map((p, i) => {
                                                    const pos = scores[p.playerName];
                                                    return (
                                                      <li key={i} className="text-xs flex items-center justify-between gap-1">
                                                        <span className="text-slate-300 truncate">{p.playerName}</span>
                                                        {pos !== undefined && (
                                                          <span className="shrink-0 font-mono text-xs"
                                                            style={{color: pos <= 10 ? '#4ade80' : pos <= 30 ? '#facc15' : '#64748b'}}>
                                                            T{pos}
                                                          </span>
                                                        )}
                                                      </li>
                                                    );
                                                  })}
                                                </ul>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                      {!hasLocked && !showPicks && (
                                        <p className="text-xs italic" style={{color:'rgba(148,163,184,0.3)'}}>
                                          Final scores weren't recorded for this event — picks preserved from the original spreadsheet.
                                        </p>
                                      )}
                                    </div>
                                  )}

                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
