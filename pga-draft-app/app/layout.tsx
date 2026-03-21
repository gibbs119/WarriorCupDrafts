import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/AuthContext';

export const metadata: Metadata = {
  title: 'PGA Draft League',
  description: 'Snake draft fantasy golf — The Players & all 4 Majors',
  // Makes app installable / full-screen on iOS home screen
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'PGA Draft',
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
      </body>
    </html>
  );
}
