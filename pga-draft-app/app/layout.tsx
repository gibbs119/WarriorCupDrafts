import React from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/AuthContext';
import { Toaster } from 'react-hot-toast';

export const metadata: Metadata = {
  title: 'Warrior Cup Drafts',
  description: 'Snake draft fantasy golf — The Players & all 4 Majors',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Warrior Cup',
    startupImage: [],
  },
  formatDetection: {
    telephone: false, // prevent iOS auto-linking phone numbers
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',   // extend under notch/Dynamic Island + home indicator
  themeColor: [
    { media: '(prefers-color-scheme: dark)',  color: '#030912' },
    { media: '(prefers-color-scheme: light)', color: '#030912' },
  ],
  interactiveWidget: 'resizes-content', // prevents keyboard pushing layout on mobile
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
