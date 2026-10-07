// CoJam mark "N3" (owner-approved 2026-10-07): headphone with a thick band, bean
// earcups and a solid green disc with a sine wave knocked out of it. Final
// geometry on a 256 grid: plain filled paths, no mask, no filter, no stroke.
// Kept in a plain module (not 'use client') so both the React <LogoMark> and the
// server-rendered share image (opengraph-image.tsx) draw the same shape.
// Source of truth for the drawing: .claude/design/logo/kit/ (gitignored); the
// gradient colours are fixed and must not be recoloured.

// Violet frame: band and earcups merged into one outline. Painted with the frame gradient.
export const MARK_FRAME =
  'M52.63 120.24A76 76 0 0 1 203.37 120.24C197.12 121.42 194 126.93 194 134L194 194C194 202 198 208 206 208C230 208 244 190 244 164C244 145.87 236.01 130.03 221.77 123.36A94 94 0 0 0 34.23 123.36C19.99 130.03 12 145.87 12 164C12 190 26 208 50 208C58 208 62 202 62 194L62 134C62 126.93 58.88 121.42 52.63 120.24Z';
// Green core: disc with the wave as a real hole (use fillRule evenodd). Painted with the core gradient.
export const MARK_DISC =
  'M188 166A60 60 0 1 0 68 166A60 60 0 1 0 188 166ZM116.51 180.33C113.05 173.24 110.74 165.66 107.23 158.59C105.37 154.84 102.99 150.8 99.1 148.87C98.16 148.41 97.15 148.08 96.1 147.94C94.56 147.72 92.99 147.89 91.52 148.41C86.27 150.24 83.59 155.45 79.93 159.22C78.73 160.45 78.04 160.13 76.72 160.99C74.58 162.39 73.56 165.07 74.21 167.54C74.47 168.5 74.97 169.4 75.66 170.12C77.63 172.19 80.45 172.36 83.02 171.44C87.03 170 89.72 166.36 92.3 163.17C93.03 162.27 93.79 161.39 94.56 160.52C98.91 167.65 101.21 176.03 104.76 183.61C106.56 187.45 108.93 191.94 112.97 193.79C114.33 194.42 115.85 194.7 117.35 194.57C121.74 194.17 124.61 190.61 126.56 186.99C128.64 183.12 130.08 178.91 131.47 174.76C134.05 167.03 136.17 159.12 139.49 151.67C142.95 158.76 145.26 166.34 148.77 173.41C150.63 177.16 153.01 181.2 156.9 183.13C157.84 183.59 158.85 183.92 159.9 184.06C161.44 184.28 163.01 184.11 164.48 183.59C169.73 181.76 172.41 176.55 176.07 172.78C177.27 171.55 177.96 171.87 179.28 171.01C181.42 169.61 182.44 166.93 181.79 164.46C181.53 163.5 181.03 162.6 180.34 161.88C178.37 159.81 175.55 159.64 172.98 160.56C168.97 162 166.28 165.64 163.7 168.83C162.97 169.73 162.21 170.61 161.44 171.48C157.09 164.35 154.79 155.97 151.24 148.39C149.44 144.55 147.07 140.06 143.03 138.21C141.67 137.58 140.15 137.3 138.65 137.43C134.26 137.83 131.39 141.39 129.44 145.01C127.36 148.88 125.92 153.09 124.53 157.24C121.95 164.97 119.83 172.88 116.51 180.33Z';
// Square box around the mark (bbox 12..244 x 36..226) so the layout slot stays square.
export const MARK_VIEWBOX = '8 11 240 240';
// Gradient geometry in the same user space (frame runs left to right, core top to bottom).
export const FRAME_GRADIENT = { x1: 12, x2: 244, y: 131 } as const;
export const CORE_GRADIENT = { x: 128, y1: 106, y2: 226 } as const;
