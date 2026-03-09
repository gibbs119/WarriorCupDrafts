'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import WarriorsLogo from './WarriorsLogo';
import { LogOut, History, Settings, Home } from 'lucide-react';

export default function Navigation() {
  const { appUser, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  async function handleSignOut() {
    await signOut();
    router.push('/');
  }

  const navLinks = [
    { href: '/dashboard', label: 'Home',    icon: Home },
    { href: '/history',   label: 'History', icon: History },
    ...(appUser?.role === 'admin'
      ? [{ href: '/admin', label: 'Admin', icon: Settings }]
      : []),
  ];

  return (
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
            <span className="font-bebas text-xl tracking-widest text-white">PGA DRAFT</span>
            <span className="font-bebas text-xs tracking-widest block" style={{ color: '#C9A227', marginTop: '-2px' }}>LEAGUE </span>
          </div>
        </Link>

        {/* Nav links */}
        <nav className="flex items-center gap-1">
          {navLinks.map(({ href, label, icon: Icon }) => {
            const isActive = pathname === href;
            return (
              <Link key={href} href={href}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all"
                style={isActive
                  ? { background: 'rgba(0,107,182,0.3)', color: '#fff', border: '1px solid rgba(0,107,182,0.5)' }
                  : { color: '#94a3b8', border: '1px solid transparent' }}
              >
                <Icon size={13} />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* User + sign out */}
        <div className="flex items-center gap-3">
          {appUser && (
            <div className="hidden sm:flex items-center gap-1.5">
              <span className="text-sm font-semibold text-white">{appUser.username}</span>
              {appUser.role === 'admin' && (
                <span className="text-xs px-1.5 py-0.5 rounded font-bold"
                  style={{ background: 'rgba(201,162,39,0.2)', color: '#C9A227', border: '1px solid rgba(201,162,39,0.35)' }}>
                  ADMIN
                </span>
              )}
            </div>
          )}
          <button onClick={handleSignOut}
            className="flex items-center gap-1 text-slate-500 hover:text-white transition-colors text-sm p-1.5 rounded-lg hover:bg-white/5">
            <LogOut size={15} />
            <span className="hidden sm:inline text-xs">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}
