'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { getAllTournaments, saveUserFcmToken } from '@/lib/db';
import { requestPushToken } from '@/lib/fcm';
import WarriorsLogo from './WarriorsLogo';
import { LogOut, History, Settings, Home, BookOpen } from 'lucide-react';
import { useEffect, useState } from 'react';

export default function Navigation() {
  const { appUser, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [hasLive, setHasLive] = useState(false);

  // Check for live/drafting tournament to show indicator
  useEffect(() => {
    if (!appUser) return;
    getAllTournaments()
      .then((ts) => setHasLive(ts.some((t) => t.status === 'active' || t.status === 'drafting')))
      .catch(() => {});
  }, [appUser]);

  // Silently refresh FCM token if permission already granted (no gesture needed).
  // First-time permission prompt requires a user tap — handled by the dashboard banner.
  useEffect(() => {
    if (!appUser) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    requestPushToken().then((token) => {
      if (token) saveUserFcmToken(appUser.uid, token).catch(() => {});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUser?.uid]);

  async function handleSignOut() {
    await signOut();
    router.push('/');
  }

  const navLinks = [
    { href: '/dashboard', label: 'Home',    icon: Home },
    { href: '/history',   label: 'History', icon: History },
    { href: '/recaps',    label: 'Recaps',  icon: BookOpen },
    ...(appUser?.role === 'admin'
      ? [{ href: '/admin', label: 'Admin', icon: Settings }]
      : []),
  ];

  return (
    <>
      <header style={{
        background: 'rgba(6,14,28,0.85)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(201,162,39,0.18)',
        paddingTop: 'env(safe-area-inset-top)',
      }}
        className="sticky top-0 z-50">
        {/* Gold accent line */}
        <div className="h-0.5 w-full" style={{ background: 'linear-gradient(90deg, transparent 0%, #C9A227 30%, #006BB6 70%, transparent 100%)' }} />

        <div className="max-w-6xl mx-auto h-14 flex items-center justify-between"
          style={{ paddingLeft: 'max(1rem, env(safe-area-inset-left))', paddingRight: 'max(1rem, env(safe-area-inset-right))' }}>

          {/* Logo + wordmark */}
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <WarriorsLogo size={32} />
            <div className="hidden sm:block leading-none">
              <span className="font-bebas text-xl tracking-widest text-white">WARRIOR CUP</span>
              <span className="font-bebas text-xs tracking-widest block" style={{ color: '#C9A227', marginTop: '-2px' }}>DRAFTS</span>
            </div>
          </Link>

          {/* Nav links — hidden on mobile (bottom tab bar handles it) */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map(({ href, label, icon: Icon }) => {
              const isActive = pathname === href || pathname.startsWith(href + '/');
              const isHome = href === '/dashboard';
              return (
                <Link key={href} href={href}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold transition-all"
                  style={isActive
                    ? { background: 'rgba(0,107,182,0.25)', color: '#60a5fa', border: '1px solid rgba(0,107,182,0.45)' }
                    : { color: '#94a3b8', border: '1px solid transparent' }}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                  {isHome && hasLive && (
                    <span className="live-dot ml-0.5" />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* User + sign out */}
          <div className="flex items-center gap-3">
            {appUser && (
              <Link href="/account" className="hidden sm:flex items-center gap-1.5 hover:opacity-80 transition-opacity">
                <span className="text-sm font-semibold text-white">{appUser.username}</span>
                {appUser.role === 'admin' && (
                  <span className="text-xs px-1.5 py-0.5 rounded font-bold"
                    style={{ background: 'rgba(201,162,39,0.2)', color: '#C9A227', border: '1px solid rgba(201,162,39,0.35)' }}>
                    ADMIN
                  </span>
                )}
              </Link>
            )}
            <button onClick={handleSignOut}
              className="flex items-center gap-1 text-slate-500 hover:text-white transition-colors text-sm p-1.5 rounded-lg hover:bg-white/5">
              <LogOut size={15} />
              <span className="hidden sm:inline text-xs">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Mobile bottom tab bar */}
      <nav className="bottom-nav md:hidden">
        {navLinks.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href + '/');
          const isHome = href === '/dashboard';
          return (
            <Link key={href} href={href}
              className="flex flex-col items-center gap-1 flex-1 py-2 transition-all"
              style={isActive ? { color: '#60a5fa' } : { color: '#475569' }}
            >
              <div className="relative">
                <Icon size={20} />
                {isHome && hasLive && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-400"
                    style={{ animation: 'live-dot 1.8s ease-out infinite' }} />
                )}
              </div>
              <span className="text-xs font-semibold tracking-wide">{label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
