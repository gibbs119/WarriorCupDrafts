'use client';

// ─── Tournament Ambient Audio ─────────────────────────────────────────────────
// Floating mini-player that streams a tournament's theme music via the
// SoundCloud Widget API. Persists play/disable preference to localStorage.
// Autoplay is intentionally disabled — user must tap play (iOS requirement).

import { useEffect, useRef, useState } from 'react';

interface Props {
  trackUrl: string;       // full SoundCloud track URL
  label: string;          // e.g. "Masters Theme"
  accent: string;         // theme accent color
  accentMid: string;      // theme accentMid color (for text)
}

// SoundCloud Widget API types
interface SCWidget {
  play: () => void;
  pause: () => void;
  setVolume: (v: number) => void;
  bind: (event: string, cb: () => void) => void;
}
declare global {
  interface Window { SC?: { Widget: (el: HTMLIFrameElement) => SCWidget } }
}

const STORAGE_KEY = 'tournament-audio-disabled';

export default function TournamentAudio({ trackUrl, label, accent, accentMid }: Props) {
  const iframeRef  = useRef<HTMLIFrameElement>(null);
  const widgetRef  = useRef<SCWidget | null>(null);
  const [ready,    setReady]    = useState(false);
  const [playing,  setPlaying]  = useState(false);
  const [muted,    setMuted]    = useState(false);
  const [disabled, setDisabled] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
  );

  // Load SC Widget API script once
  useEffect(() => {
    if (disabled) return;
    if (window.SC) { initWidget(); return; }
    const s = document.createElement('script');
    s.src = 'https://w.soundcloud.com/player/api.js';
    s.onload = initWidget;
    document.head.appendChild(s);
    return () => { s.onload = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  function initWidget() {
    if (!iframeRef.current || !window.SC) return;
    const w = window.SC.Widget(iframeRef.current);
    widgetRef.current = w;
    w.bind('ready', () => {
      setReady(true);
      // Attempt autoplay — works on Android/desktop; iOS PWA may still block
      // but the iframe auto_play=true above handles that case
      try { w.play(); } catch { /* blocked — user must tap */ }
    });
    w.bind('play',   () => setPlaying(true));
    w.bind('pause',  () => setPlaying(false));
    w.bind('finish', () => setPlaying(false));
    w.setVolume(70);
  }

  function togglePlay() {
    const w = widgetRef.current;
    if (!w || !ready) return;
    playing ? w.pause() : w.play();
  }

  function toggleMute() {
    const w = widgetRef.current;
    if (!w) return;
    if (muted) { w.setVolume(70); setMuted(false); }
    else       { w.setVolume(0);  setMuted(true);  }
  }

  function disable() {
    widgetRef.current?.pause();
    localStorage.setItem(STORAGE_KEY, '1');
    setDisabled(true);
    setPlaying(false);
  }

  function enable() {
    localStorage.removeItem(STORAGE_KEY);
    setDisabled(false);
  }

  const iframeSrc = [
    'https://w.soundcloud.com/player/',
    `?url=${encodeURIComponent(trackUrl)}`,
    `&color=${encodeURIComponent(accent)}`,
    '&auto_play=true&hide_related=true&show_comments=false',
    '&show_user=false&show_reposts=false&show_teaser=false',
  ].join('');

  // ── Disabled state — tiny re-enable pill ────────────────────────────────────
  if (disabled) {
    return (
      <button
        onClick={enable}
        className="fixed bottom-24 right-4 z-40 rounded-full w-10 h-10 flex items-center justify-center text-lg shadow-xl transition-opacity opacity-40 hover:opacity-80"
        style={{ background: 'rgba(3,9,18,0.92)', border: `1px solid ${accent}50`, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
        title="Enable Masters theme music"
      >
        🎵
      </button>
    );
  }

  // ── Active state — floating control pill ───────────────────────────────────
  return (
    <>
      {/* Hidden SoundCloud iframe — audio source */}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        allow="autoplay"
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none', border: 'none' }}
        aria-hidden
      />

      {/* Floating pill */}
      <div
        className="fixed bottom-24 right-4 z-40 flex items-center gap-2 rounded-full pl-3 pr-2 shadow-xl"
        style={{
          height: '38px',
          background: 'rgba(3,9,18,0.95)',
          border: `1px solid ${accent}70`,
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          boxShadow: `0 4px 24px rgba(0,0,0,0.7), 0 0 0 1px ${accent}30`,
        }}
      >
        {/* Play / Pause */}
        <button
          onClick={togglePlay}
          disabled={!ready}
          className="flex items-center gap-1.5 text-xs font-bold tracking-wide transition-all disabled:opacity-40"
          style={{ color: playing ? accentMid : accent }}
        >
          <span style={{ fontSize: '0.85rem' }}>{playing ? '⏸' : '▶'}</span>
          <span>{ready && !playing ? 'Tap to play' : label}</span>
          {!ready && <span className="opacity-50 text-slate-400">…</span>}
        </button>

        {/* Animated equalizer bars when playing */}
        {playing && (
          <div className="flex items-end gap-px h-3 ml-1">
            {[0.6, 1, 0.75, 0.9, 0.5].map((h, i) => (
              <div
                key={i}
                className="w-0.5 rounded-full"
                style={{
                  height: `${h * 12}px`,
                  background: accentMid,
                  animation: `eq-bar ${0.5 + i * 0.1}s ease-in-out infinite alternate`,
                  opacity: 0.85,
                }}
              />
            ))}
          </div>
        )}

        {/* Mute / unmute */}
        <button
          onClick={toggleMute}
          className="text-sm opacity-60 hover:opacity-100 transition-opacity ml-1"
          style={{ color: muted ? '#f87171' : accentMid }}
          title={muted ? 'Unmute' : 'Mute (saves battery)'}
        >
          {muted ? '🔇' : '🔊'}
        </button>

        {/* Divider */}
        <div className="w-px h-4 mx-0.5" style={{ background: `${accent}40` }} />

        {/* Dismiss */}
        <button
          onClick={disable}
          className="text-slate-500 hover:text-slate-300 transition-colors px-1 text-xs"
          title="Turn off music"
        >
          ✕
        </button>
      </div>
    </>
  );
}
