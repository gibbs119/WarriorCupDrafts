// Warriors shield logo — matches the Warrior Cup app's visual identity

export default function WarriorsLogo({ size = 48 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size * 1.15}
      viewBox="0 0 100 115"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Shield outline */}
      <path
        d="M50 4 L96 20 L96 62 C96 84 73 104 50 111 C27 104 4 84 4 62 L4 20 Z"
        fill="url(#shieldGrad)"
        stroke="url(#borderGrad)"
        strokeWidth="2.5"
      />
      {/* Inner shield bevel */}
      <path
        d="M50 11 L89 25 L89 62 C89 80 69 98 50 104 C31 98 11 80 11 62 L11 25 Z"
        fill="none"
        stroke="rgba(201,162,39,0.25)"
        strokeWidth="1"
      />
      {/* Block W */}
      <text
        x="50"
        y="73"
        textAnchor="middle"
        fontFamily="'Arial Black', 'Impact', sans-serif"
        fontWeight="900"
        fontSize="52"
        fill="url(#goldGrad)"
        letterSpacing="-2"
      >
        W
      </text>
      {/* Top gold bar */}
      <rect x="12" y="18" width="76" height="5" rx="2.5" fill="url(#goldGrad)" opacity="0.8" />

      <defs>
        <linearGradient id="shieldGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0D1F38" />
          <stop offset="100%" stopColor="#060E1C" />
        </linearGradient>
        <linearGradient id="borderGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C9A227" />
          <stop offset="60%" stopColor="#006BB6" />
          <stop offset="100%" stopColor="#004F8C" />
        </linearGradient>
        <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E0C468" />
          <stop offset="50%" stopColor="#C9A227" />
          <stop offset="100%" stopColor="#A07A14" />
        </linearGradient>
      </defs>
    </svg>
  );
}
