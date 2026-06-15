'use client';

interface Props {
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}

export default function LoadingSpinner({ size = 'md', label }: Props) {
  const px = size === 'sm' ? 16 : size === 'lg' ? 36 : 24;
  return (
    <div className="flex flex-col items-center gap-3">
      <svg width={px} height={px} viewBox="0 0 24 24" fill="none"
        style={{ animation: 'spin 0.9s linear infinite' }}
        aria-label={label ?? 'Loading'} role="status">
        <circle cx="12" cy="12" r="10" stroke="rgba(255,255,255,0.12)" strokeWidth="3" />
        <path d="M12 2 a10 10 0 0 1 10 10" stroke="#006BB6" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label && <span className="text-sm text-slate-400 font-medium">{label}</span>}
    </div>
  );
}
