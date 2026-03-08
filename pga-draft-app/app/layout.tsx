import React from 'react';
import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/lib/AuthContext';

export const metadata: Metadata = {
  title: 'PGA Draft League',
  description: 'Snake draft fantasy golf — The Players & all 4 Majors · 2025',
};

export default function RootLayout(props: { children: React.ReactNode }) {
  const { children } = props;
  return (
    <html lang="en">
      <body className="bg-warriors min-h-screen">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
