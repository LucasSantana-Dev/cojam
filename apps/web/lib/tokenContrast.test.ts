// Contrast audit for globals.css static tokens (#402).
// Reuses oklchToSrgb from lib/trackColor.ts and derives WCAG relative
// luminance from the gamma-encoded output.
import { describe, expect, it } from 'vitest'
import { oklchToSrgb } from './trackColor'
import type { Tint } from './trackColor'

// Inverse sRGB transfer function: gamma-encoded channel → linear light.
const toLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4

function luminance(t: Tint): number {
  const [r, g, b] = oklchToSrgb(t).map(toLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function wcagContrast(a: Tint, b: Tint): number {
  const la = luminance(a)
  const lb = luminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

// ---- Token values from apps/web/app/globals.css --------------------------------
const surface0: Tint = { l: 0.08, c: 0, h: 0 }
const surface1: Tint = { l: 0.11, c: 0.01, h: 280 }
const surface2: Tint = { l: 0.14, c: 0.01, h: 280 }
const surface3: Tint = { l: 0.18, c: 0.01, h: 280 }
const textPrimary: Tint = { l: 0.96, c: 0.01, h: 280 }
const textSecondary: Tint = { l: 0.62, c: 0.02, h: 280 }
const textMuted: Tint = { l: 0.48, c: 0.01, h: 280 }
const accent: Tint = { l: 0.66, c: 0.2, h: 300 }

const surfaces = [surface0, surface1, surface2, surface3]
const surfaceNames = ['surface-0', 'surface-1', 'surface-2', 'surface-3']

describe('token contrast ratios (#402)', () => {
  it.each(surfaces.map((s, i) => [surfaceNames[i], s] as [string, Tint]))(
    '--color-text-primary >= 4.5:1 on %s',
    (_name, surface) => {
      const ratio = wcagContrast(textPrimary, surface)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(surfaces.map((s, i) => [surfaceNames[i], s] as [string, Tint]))(
    '--color-text-secondary >= 4.5:1 on %s',
    (_name, surface) => {
      const ratio = wcagContrast(textSecondary, surface)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(surfaces.map((s, i) => [surfaceNames[i], s] as [string, Tint]))(
    '--color-accent >= 3:1 on %s',
    (_name, surface) => {
      const ratio = wcagContrast(accent, surface)
      expect(ratio).toBeGreaterThanOrEqual(3)
    },
  )

  it('prints muted ratios (informational only)', () => {
    for (let i = 0; i < surfaces.length; i++) {
      const ratio = wcagContrast(textMuted, surfaces[i])
      // Report but do not assert — changing this token is an owner design call.
      console.log(
        `--color-text-muted on ${surfaceNames[i]}: ${ratio.toFixed(2)}:1`,
      )
    }
  })
})
