// CoJam mark: "Two Listeners" (ADR-0004, amended). A headphone whose earcups
// are two presence dots joined by the headband arc, with a pulse riding the
// band: the connection metaphor is built into the anatomy. Token-driven color;
// the optional glow is off by default (muddies below ~24px).
export function LogoMark({ size = 16, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      aria-hidden
      focusable="false"
    >
      {glow && (
        <>
          <defs>
            <radialGradient id="cojam-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.4" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="64" cy="64" r="62" fill="url(#cojam-glow)" />
        </>
      )}
      <path
        d="M 26 78 A 38 38 0 0 1 102 78"
        stroke="var(--color-accent)"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <circle cx="26" cy="86" r="15" fill="var(--color-accent)" />
      <circle cx="102" cy="86" r="15" fill="var(--color-accent)" />
      <circle cx="64" cy="40" r="7" fill="var(--color-accent)" opacity="0.9" />
    </svg>
  );
}
