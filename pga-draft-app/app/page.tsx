'use client';
import React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import WarriorsLogo from '@/components/WarriorsLogo';
import { USERS } from '@/lib/constants';

export default function LoginPage() {
  const { signIn, appUser, loading } = useAuth();
  const router = useRouter();

  // Already logged in — skip straight to dashboard
  React.useEffect(() => {
    if (!loading && appUser) router.replace('/dashboard');
  }, [loading, appUser, router]);
  const [selectedUser, setSelectedUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser) { setError('Please select your name.'); return; }
    setError('');
    setLoading(true);
    try {
      // Look up email from selected username
      const user = USERS.find((u) => u.username === selectedUser);
      if (!user) throw new Error('Unknown user');
      await signIn(user.email, password);
      router.push('/dashboard');
    } catch {
      setError('Wrong password. Contact Gibbs if you need a reset.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen page flex items-center justify-center px-4 py-12 relative">

      {/* Background glows */}
      <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-72 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(ellipse, rgba(0,107,182,0.22) 0%, transparent 70%)' }} />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(201,162,39,0.12) 0%, transparent 70%)' }} />

      <div className="w-full max-w-sm relative z-10">

        {/* Hero */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="rounded-full p-2" style={{ background: 'rgba(13,43,107,0.3)', boxShadow: '0 0 32px rgba(201,162,39,0.2)' }}>
              <WarriorsLogo size={88} />
            </div>
          </div>

          <h1 className="font-bebas text-5xl tracking-widest text-white leading-none">
            PGA DRAFT
          </h1>
          <p className="font-bebas text-2xl tracking-widest mt-0.5" style={{ color: '#C9A227' }}>
            LEAGUE
          </p>
          <p className="text-slate-400 text-xs mt-2 tracking-wide uppercase">
            The Players · Masters · PGA · US Open · The Open
          </p>
        </div>

        {/* Login card */}
        <div className="card glow-royal">
          <div className="h-0.5 -mt-5 -mx-5 mb-5 rounded-t-2xl"
            style={{ background: 'linear-gradient(90deg, transparent, #C9A227, transparent)' }} />

          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Name selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Who are you?
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {USERS.map((u) => (
                  <button
                    key={u.username}
                    type="button"
                    onClick={() => setSelectedUser(u.username)}
                    className="py-2 px-1 rounded-lg text-sm font-semibold transition-all text-center"
                    style={{
                      background: selectedUser === u.username
                        ? 'rgba(201,162,39,0.25)'
                        : 'rgba(255,255,255,0.05)',
                      border: `1.5px solid ${selectedUser === u.username
                        ? '#C9A227'
                        : 'rgba(255,255,255,0.08)'}`,
                      color: selectedUser === u.username ? '#C9A227' : '#94a3b8',
                    }}
                  >
                    {u.username}
                  </button>
                ))}
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="input"
                required
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm text-center py-2 rounded-lg bg-red-900/20 border border-red-800/40">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !selectedUser}
              className="btn-gold w-full py-3 font-bebas tracking-widest text-lg justify-center disabled:opacity-40"
            >
              {loading ? 'SIGNING IN…' : selectedUser ? `SIGN IN AS ${selectedUser.toUpperCase()}` : 'SELECT YOUR NAME'}
            </button>
          </form>
        </div>

        <p className="text-center text-slate-600 text-xs mt-5">
          Contact Gibbs for your password
        </p>
      </div>
    </div>
  );
}
