import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/AuthContext';
import { Toaster } from 'react-hot-toast';

export const metadata: Metadata = {
  title: 'Warrior Cup Drafts',
  description: 'Snake draft fantasy golf — The Players & all 4 Majors',
  // Makes app installable / full-screen on iOS home screen
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Warrior Cup',
  },
};

export const viewport: Viewport = {
  // "viewport-fit=cover" lets content extend under iPhone notch/Dynamic Island
  // and home indicator — we then use env(safe-area-inset-*) in CSS to pad correctly
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,        // prevents accidental pinch-zoom on form inputs
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#030912',  // colors the iOS status bar area
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-warriors min-h-dvh">
        <AuthProvider children={children} />
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 3500,
            style: {
              background: '#0A1628',
              color: '#F0F4FF',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '0.75rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            },
            success: {
              iconTheme: { primary: '#4ade80', secondary: '#0A1628' },
            },
            error: {
              iconTheme: { primary: '#f87171', secondary: '#0A1628' },
            },
          }}
        />
      </body>
    </html>
  );
}
