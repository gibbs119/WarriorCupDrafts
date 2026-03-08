// Warriors Block W logo — matches actual Whitesboro Warriors identity
// Navy blue W with white outline, bold angular style matching Image 3

export default function WarriorsLogo({ size = 48 }: { size?: number }) {
  const h = Math.round(size * 0.82);
  return (
    <svg
      width={size}
      height={h}
      viewBox="0 0 120 98"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* White outline layer — renders behind navy fill to create the white border */}
      <text
        x="60" y="86"
        textAnchor="middle"
        fontFamily="'Arial Black', 'Franklin Gothic Heavy', 'Impact', sans-serif"
        fontWeight="900"
        fontSize="98"
        fill="white"
        stroke="white"
        strokeWidth="10"
        strokeLinejoin="round"
        letterSpacing="-4"
      >W</text>
      {/* Navy fill on top */}
      <text
        x="60" y="86"
        textAnchor="middle"
        fontFamily="'Arial Black', 'Franklin Gothic Heavy', 'Impact', sans-serif"
        fontWeight="900"
        fontSize="98"
        fill="#0D2B6B"
        letterSpacing="-4"
      >W</text>
    </svg>
  );
}
