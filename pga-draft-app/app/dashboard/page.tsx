'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { getAllTournaments } from '@/lib/db';
import Navigation from '@/components/Navigation';
import TournamentCard from '@/components/TournamentCard';
import WarriorsLogo from '@/components/WarriorsLogo';
import type { Tournament } from '@/lib/types';
type TournamentItem = Tournament;
import { TOURNAMENTS } from '@/lib/constants';

export default function Dashboard() {
  const { appUser, loading } = useAuth();
  const router = useRouter();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (!loading && !appUser) router.push('/');
  }, [loading, appUser, router]);

  useEffect(() => {
    if (!appUser) return;
    async function load() {
      try {
        const data = await getAllTournaments();
        const order = TOURNAMENTS.map((t) => t.id);
        data.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        setTournaments(data.length > 0 ? data : (TOURNAMENTS as Tournament[]));
      } catch {
        setTournaments(TOURNAMENTS as Tournament[]);
      } finally {
        setFetching(false);
      }
    }
    load();
  }, [appUser]);

  if (loading || !appUser) {
    return (
      <div className="min-h-screen page">
        <div className="max-w-4xl mx-auto px-4 py-8 space-y-4">
          <div className="skeleton h-10 w-48 mb-6 rounded-xl" />
          <div className="skeleton h-20 w-full rounded-xl" />
          <div className="grid gap-4 sm:grid-cols-2">
            {[1,2,3,4,5].map(i => <div key={i} className="skeleton h-32 rounded-xl" />)}
          </div>
        </div>
      </div>
    );
  }

  const activeTournament = tournaments.find(
    (t) => t.status === 'active' || t.status === 'drafting'
  );

  return (
    <div className="min-h-screen page">
      <Navigation />

      {/* Page-level glow */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[900px] h-64 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse, rgba(0,107,182,0.12) 0%, transparent 70%)' }} />

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-8">

        {/* Welcome header */}
        <div className="mb-8">
          <p className="text-slate-500 text-sm uppercase tracking-widest font-semibold mb-1">Welcome back</p>
          <h1 className="font-bebas text-4xl tracking-widest text-white leading-none">
            {appUser.username}
            {appUser.role === 'admin' && (
              <span className="ml-3 text-sm font-sans px-2 py-0.5 rounded font-bold align-middle"
                style={{ background: 'rgba(201,162,39,0.2)', color: '#C9A227', border: '1px solid rgba(201,162,39,0.35)' }}>
                ADMIN
              </span>
            )}
          </h1>
          <p className="text-slate-500 text-sm mt-1">Warrior Cup Drafts · The Players + All 4 Majors</p>
        </div>

        {/* Active tournament callout */}
        {activeTournament && (
          <div className="card-gold glow-gold mb-6 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest mb-1"
                style={{ color: activeTournament.status === 'drafting' ? '#C9A227' : '#4ade80' }}>
                {activeTournament.status === 'drafting' ? '🟡 Draft Open' : '🟢 Live Now'}
              </p>
              <p className="font-bebas text-2xl tracking-wider text-white leading-none">{activeTournament.name}</p>
            </div>
            <button
              onClick={() => router.push(
                activeTournament.status === 'drafting'
                  ? `/draft/${activeTournament.id}`
                  : `/leaderboard/${activeTournament.id}`
              )}
              className="btn-gold shrink-0 font-bebas tracking-widest text-base"
            >
              {activeTournament.status === 'drafting' ? 'ENTER DRAFT' : 'LIVE SCORES'}
            </button>
          </div>
        )}

        {/* Scoring rules */}
        <details className="card mb-6 cursor-pointer group">
          <summary className="flex items-center justify-between font-semibold text-white select-none list-none">
            <span className="flex items-center gap-2">
              <span style={{ color: '#C9A227' }}>📖</span>
              Scoring Rules
            </span>
            <span className="text-slate-500 text-sm group-open:rotate-180 transition-transform">▼</span>
          </summary>
          <div className="mt-4 space-y-3 text-sm text-slate-400">
            <p>Only your <strong className="text-white">best 3 players</strong> count toward your team score. Lower = better (like golf).</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs mt-2">
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <th className="text-left py-1.5 text-slate-500 font-semibold uppercase tracking-wider">Finish</th>
                    <th className="text-left py-1.5 text-slate-500 font-semibold uppercase tracking-wider">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['1st',    '-25'], ['2nd',  '-15'], ['3rd',  '-10'], ['4th',   '-8'],
                    ['5th',    '-6'],  ['6th',  '-5'],  ['7th',  '-4'],  ['8th',   '-3'],
                    ['9th',    '-2'],  ['10th', '-1'],
                    ['11th+',  '= finishing position'],
                    ['Cut / WD', 'Cut line position + 1'],
                  ].map(([pos, pts]) => (
                    <tr key={pos} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td className="py-1.5 text-slate-300">{pos}</td>
                      <td className="py-1.5 font-mono" style={{ color: pts.startsWith('-') ? '#f87171' : '#94a3b8' }}>{pts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">Ties: all tied players share that position's points. Tiebreaker: best individual position across full roster.</p>
          </div>
        </details>

        {/* Tournaments */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bebas text-2xl tracking-widest text-white">Tournaments</h2>
          <span className="text-xs text-slate-500">{tournaments.length} events</span>
        </div>

        {fetching ? (
          <div className="text-slate-500 text-sm animate-pulse text-center py-8">Loading tournaments…</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {tournaments.map((t: Tournament) => (
              <React.Fragment key={t.id}>
                <TournamentCard tournament={t} />
              </React.Fragment>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
