'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import toast from 'react-hot-toast';
import { Lock, Mail, User, ChevronLeft } from 'lucide-react';

export default function AccountPage() {
  const { appUser, changePassword, changeEmail, loading } = useAuth();
  const router = useRouter();

  // Password form
  const [currentPw, setCurrentPw]   = useState('');
  const [newPw, setNewPw]           = useState('');
  const [confirmPw, setConfirmPw]   = useState('');
  const [savingPw, setSavingPw]     = useState(false);

  // Email form
  const [emailPw, setEmailPw]       = useState('');
  const [newEmail, setNewEmail]     = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  if (loading) return null;
  if (!appUser) { router.replace('/'); return null; }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (newPw !== confirmPw) { toast.error('New passwords do not match'); return; }
    if (newPw.length < 6)    { toast.error('Password must be at least 6 characters'); return; }
    setSavingPw(true);
    const tid = toast.loading('Updating password…');
    try {
      await changePassword(currentPw, newPw);
      toast.success('Password updated', { id: tid });
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes('wrong-password') || msg.includes('invalid-credential')
        ? 'Current password is incorrect'
        : 'Failed to update password';
      toast.error(friendly, { id: tid });
    } finally {
      setSavingPw(false);
    }
  }

  async function handleEmailChange(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail.includes('@')) { toast.error('Enter a valid email address'); return; }
    setSavingEmail(true);
    const tid = toast.loading('Updating email…');
    try {
      await changeEmail(emailPw, newEmail);
      toast.success('Verification email sent — click the link to confirm your new address', { id: tid, duration: 6000 });
      setEmailPw(''); setNewEmail('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes('wrong-password') || msg.includes('invalid-credential')
        ? 'Password is incorrect'
        : msg.includes('email-already-in-use')
        ? 'That email is already in use'
        : 'Failed to update email';
      toast.error(friendly, { id: tid });
    } finally {
      setSavingEmail(false);
    }
  }

  return (
    <div className="page max-w-lg mx-auto px-4 py-8 space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <button onClick={() => router.back()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
          <ChevronLeft size={20} />
        </button>
        <h1 className="font-bebas text-3xl tracking-widest text-white">Account Settings</h1>
      </div>

      {/* Identity card */}
      <div className="card flex items-center gap-4">
        <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 font-bebas text-xl"
          style={{ background: 'rgba(0,107,182,0.3)', border: '1.5px solid rgba(0,107,182,0.5)', color: '#60a5fa' }}>
          {appUser.username[0].toUpperCase()}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-white">{appUser.username}</span>
            {appUser.role === 'admin' && (
              <span className="text-xs px-1.5 py-0.5 rounded font-bold"
                style={{ background: 'rgba(201,162,39,0.2)', color: '#C9A227', border: '1px solid rgba(201,162,39,0.35)' }}>
                ADMIN
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Mail size={12} className="text-slate-500" />
            <span className="text-sm text-slate-400">{appUser.email}</span>
          </div>
        </div>
      </div>

      {/* Change Password */}
      <div className="card space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Lock size={15} style={{ color: '#C9A227' }} />
          <h2 className="font-semibold text-white">Change Password</h2>
        </div>

        <form onSubmit={handlePasswordChange} className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
              Current Password
            </label>
            <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)}
              placeholder="••••••••" className="input" required />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
              New Password
            </label>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)}
              placeholder="••••••••" className="input" required minLength={6} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
              Confirm New Password
            </label>
            <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="••••••••" className="input" required minLength={6} />
          </div>
          <button type="submit" disabled={savingPw}
            className="btn-gold w-full py-2.5 font-bebas tracking-widest justify-center disabled:opacity-40">
            {savingPw ? 'SAVING…' : 'UPDATE PASSWORD'}
          </button>
        </form>
      </div>

      {/* Change Email */}
      <div className="card space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <User size={15} style={{ color: '#C9A227' }} />
          <h2 className="font-semibold text-white">Change Email</h2>
        </div>

        <form onSubmit={handleEmailChange} className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
              Current Password
            </label>
            <input type="password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)}
              placeholder="••••••••" className="input" required />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
              New Email Address
            </label>
            <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
              placeholder="you@example.com" className="input" required />
          </div>
          <button type="submit" disabled={savingEmail}
            className="btn-gold w-full py-2.5 font-bebas tracking-widest justify-center disabled:opacity-40">
            {savingEmail ? 'SAVING…' : 'UPDATE EMAIL'}
          </button>
        </form>
      </div>

    </div>
  );
}
