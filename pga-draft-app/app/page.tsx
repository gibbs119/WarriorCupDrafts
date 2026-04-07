'use client';
import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, type GooglePendingUser } from '@/lib/AuthContext';
import { getUserByUsername } from '@/lib/db';
import WarriorsLogo from '@/components/WarriorsLogo';
import { USERS } from '@/lib/constants';

export default function LoginPage() {
  const { signIn, signInWithGoogle, linkGoogleAccount, appUser, loading } = useAuth();
  const router = useRouter();

  // Already logged in — skip straight to dashboard
  React.useEffect(() => {
    if (!loading && appUser) router.replace('/dashboard');
  }, [loading, appUser, router]);

  const [selectedUser, setSelectedUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Google one-time account linking state
  const [googlePending, setGooglePending] = useState<GooglePendingUser | null>(null);
  const [linkUsername, setLinkUsername] = useState('');
  const [linking, setLinking] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser) { setError('Please select your name.'); return; }
    setError('');
    setSubmitting(true);
    try {
      let email: string | undefined;
      try {
        const dbUser = await getUserByUsername(selectedUser);
        email = dbUser?.email;
      } catch {
        // DB unavailable — fall through to constant
      }
      if (!email) {
        email = USERS.find((u) => u.username === selectedUser)?.email;
      }
      if (!email) throw new Error('Unknown user');
      await signIn(email, password);
      router.push('/dashboard');
    } catch {
      setError('Wrong password. Contact Gibbs if you need a reset.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogleSignIn() {
    setError('');
    setSubmitting(true);
    try {
      const result = await signInWithGoogle();
      if (result.status === 'ok') {
        router.push('/dashboard');
      } else {
        // First Google login — need to know which league member they are
        setGooglePending(result.pending);
        setLinkUsername('');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('popup-closed-by-user') || msg.includes('cancelled-popup-request')) return;
      setError('Google sign-in failed. Try again or use password login.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLinkAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!googlePending || !linkUsername) return;
    setLinking(true);
    try {
      await linkGoogleAccount(googlePending, linkUsername);
      router.push('/dashboard');
    } catch {
      setError('Failed to link account. Try again.');
      setGooglePending(null);
    } finally {
      setLinking(false);
    }
  }

  // ── One-time Google account linking screen ────────────────────────────────
  if (googlePending) {
    return (
      <div className="min-h-screen page flex items-center justify-center px-4 py-12 relative">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-72 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(ellipse, rgba(0,107,182,0.22) 0%, transparent 70%)' }} />

        <div className="w-full max-w-sm relative z-10">
          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <div className="rounded-full p-2" style={{ background: 'rgba(13,43,107,0.3)', boxShadow: '0 0 32px rgba(201,162,39,0.2)' }}>
                <WarriorsLogo size={72} />
              </div>
            </div>
            <h1 className="font-bebas text-3xl tracking-widest text-white">One-Time Setup</h1>
            <p className="text-slate-400 text-sm mt-1">
              Signed in as <span className="text-white font-medium">{googlePending.googleEmail}</span>
            </p>
            <p className="text-slate-500 text-xs mt-1">Which league member are you?</p>
          </div>

          <div className="card glow-royal">
            <div className="h-0.5 -mt-5 -mx-5 mb-5 rounded-t-2xl"
              style={{ background: 'linear-gradient(90deg, transparent, #C9A227, transparent)' }} />

            <form onSubmit={handleLinkAccount} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                  Select your name
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {USERS.map((u) => (
                    <button
                      key={u.username}
                      type="button"
                      onClick={() => setLinkUsername(u.username)}
                      className="py-2 px-1 rounded-lg text-sm font-semibold transition-all text-center"
                      style={{
                        background: linkUsername === u.username
                          ? 'rgba(201,162,39,0.25)'
                          : 'rgba(255,255,255,0.05)',
                        border: `1.5px solid ${linkUsername === u.username
                          ? '#C9A227'
                          : 'rgba(255,255,255,0.08)'}`,
                        color: linkUsername === u.username ? '#C9A227' : '#94a3b8',
                      }}
                    >
                      {u.username}
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <p className="text-red-400 text-sm text-center py-2 rounded-lg bg-red-900/20 border border-red-800/40">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={linking || !linkUsername}
                className="btn-gold w-full py-3 font-bebas tracking-widest text-lg justify-center disabled:opacity-40"
              >
                {linking ? 'LINKING…' : linkUsername ? `I AM ${linkUsername.toUpperCase()}` : 'SELECT YOUR NAME'}
              </button>
            </form>
          </div>

          <p className="text-center text-slate-600 text-xs mt-4">
            You only need to do this once — future Google logins will log you in automatically.
          </p>
        </div>
      </div>
    );
  }

  // ── Normal login screen ───────────────────────────────────────────────────
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

          {/* Google sign-in */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={submitting}
            className="w-full flex items-center justify-center gap-3 py-2.5 rounded-xl font-semibold text-sm transition-all disabled:opacity-40"
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '1.5px solid rgba(255,255,255,0.12)',
              color: '#e2e8f0',
            }}
          >
            {/* Google "G" logo */}
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
              <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-slate-600 text-xs">or</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

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
              disabled={submitting || !selectedUser}
              className="btn-gold w-full py-3 font-bebas tracking-widest text-lg justify-center disabled:opacity-40"
            >
              {submitting ? 'SIGNING IN…' : selectedUser ? `SIGN IN AS ${selectedUser.toUpperCase()}` : 'SELECT YOUR NAME'}
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
