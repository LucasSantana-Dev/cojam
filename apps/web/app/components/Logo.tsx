// Cojam mark: a violet dot inside one soft concentric ring, "a room with
// presence inside" (see docs/adr/0004). Pure geometry so it stays crisp at
// every size; the glow is optional and off by default (it muddies below ~24px,
// per the 16px legibility gate from the logo decision).
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
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.45" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="64" cy="64" r="62" fill="url(#cojam-glow)" />
        </>
      )}
      <circle
        cx="64"
        cy="64"
        r="44"
        stroke="var(--color-accent)"
        strokeWidth="9"
        opacity="0.55"
      />
      <circle cx="64" cy="64" r="24" fill="var(--color-accent)" />
    </svg>
  );
}
