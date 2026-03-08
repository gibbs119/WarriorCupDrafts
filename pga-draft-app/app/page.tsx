'use client';
import React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import WarriorsLogo from '@/components/WarriorsLogo';

export default function LoginPage() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email, password);
      router.push('/dashboard');
    } catch {
      setError('Invalid email or password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 relative overflow-hidden">

      {/* Background glows */}
      <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-72 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(ellipse, rgba(0,107,182,0.22) 0%, transparent 70%)' }} />
      <div className="absolute -bottom-24 -right-24 w-96 h-96 rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(201,162,39,0.12) 0%, transparent 70%)' }} />

      <div className="w-full max-w-sm relative z-10">

        {/* Hero */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <div className="glow-gold rounded-full p-1">
              <WarriorsLogo size={80} />
            </div>
          </div>

          <h1 className="font-bebas text-5xl tracking-widest text-white leading-none">
            PGA DRAFT
          </h1>
          <p className="font-bebas text-2xl tracking-widest mt-0.5"
            style={{ color: '#C9A227' }}>
            LEAGUE · 2025
          </p>
          <p className="text-slate-400 text-xs mt-2 tracking-wide uppercase">
            The Players · Masters · PGA · US Open · The Open
          </p>
        </div>

        {/* Login card */}
        <div className="card glow-royal">
          {/* Gold top accent bar */}
          <div className="h-0.5 -mt-5 -mx-5 mb-5 rounded-t-2xl"
            style={{ background: 'linear-gradient(90deg, transparent, #C9A227, transparent)' }} />

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@pgadraft.com"
                className="input"
                required
              />
            </div>

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
              disabled={loading}
              className="btn-gold w-full py-3 text-base font-bebas tracking-widest text-lg justify-center"
            >
              {loading ? 'SIGNING IN…' : 'SIGN IN'}
            </button>
          </form>
        </div>

        <p className="text-center text-slate-600 text-xs mt-5">
          Contact Gibbs for login credentials
        </p>
      </div>
    </div>
  );
}
