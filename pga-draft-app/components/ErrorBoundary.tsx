'use client';
import { Component, ReactNode } from 'react';

interface Props { children: ReactNode; fallback?: ReactNode; }
interface State { hasError: boolean; message: string; }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }
  render() {
    if (!this.state.hasError) return this.props.children;
    return this.props.fallback ?? (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="card max-w-sm w-full text-center space-y-3">
          <p className="text-2xl">⚠️</p>
          <p className="font-bold text-white">Something went wrong</p>
          <p className="text-sm text-slate-400">{this.state.message || 'An unexpected error occurred.'}</p>
          <button className="btn-primary w-full mt-2" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
