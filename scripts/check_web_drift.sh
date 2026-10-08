#!/usr/bin/env bash
# check_web_drift.sh — CSS/brand drift checks born from real failures.
# Rule 1 protects against: renaming a @keyframes and orphaning animation refs
#   (docs/failures/css-keyframe-rename-orphans.md — hero subcopy/CTA went invisible).
# Rule 3 protects against: green leaking onto actions (docs: green = LIVE only; violet
#   --color-accent is every action and focus; #325 found three green links).
# Rule 4: brand logo colours live on .svc-badge only (owner anchor: coloured service badges).
# Rule 2 protects against: off-palette Tailwind color utilities on a violet-only brand
#   (docs/failures/subagent-offbrand-color-drift.md — orange-300 shipped by a builder agent).
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

css=apps/web/app/globals.css

# 1. Every `animation: <name>` in globals.css must have a matching @keyframes.
refs=$(grep -oE 'animation: [a-zA-Z0-9-]+' "$css" | awk '{print $2}' | sort -u | grep -v '^none$' || true)
for name in $refs; do
  if ! grep -q "@keyframes $name" "$css"; then
    echo "DRIFT: animation '$name' referenced in $css but no '@keyframes $name' exists"
    fail=1
  fi
done

# 2. No off-palette Tailwind color utilities in web app code (brand accent is violet;
#    use the --color-* tokens). Raw hex in data (per-source badge colors) is allowed.
if grep -rnE '(text|bg|border|from|to|ring)-(orange|amber|yellow|lime|emerald|teal|cyan|sky|rose|pink|fuchsia)-[0-9]+' apps/web/app --include='*.tsx'; then
  echo "DRIFT: off-palette Tailwind color utility above; use var(--color-*) tokens instead"
  fail=1
fi

# 3. Green (--color-accent-2, the --logo-core-* gradient) is LIVE-only. A use outside the
#    allowlist of LIVE selectors below fails. Declarations (`--x: ...`) and comments are
#    skipped. To add a new LIVE surface, add its selector to LIVE_SELECTORS.
LIVE_SELECTORS='^\.r4-live|^\.eyebrow\.is-live|^\.room-card__live|^\.room-card__dot|^\.eq span|^\.queue-thumb-eq'
green=$(awk -v live="$LIVE_SELECTORS" '
  /\/\*/ { incomment = 1 }
  incomment { if ($0 ~ /\*\//) incomment = 0; next }
  /\{[[:space:]]*$/ { sel = $0; sub(/^[[:space:]]+/, "", sel) }
  /--color-accent-2|--logo-core-/ && $0 !~ /^[[:space:]]*--[a-z0-9-]+:/ {
    if (sel !~ live) printf "%d: [%s] %s\n", NR, sel, $0
  }
' "$css")
if [ -n "$green" ]; then
  echo "$green"
  echo "DRIFT: green (accent-2 / logo-core) used outside a LIVE selector in $css; actions use var(--color-accent)"
  fail=1
fi
if grep -rnE 'color-accent-2|logo-core' apps/web/app --include='*.tsx' \
  | grep -vE 'Logo\.tsx|\.test\.tsx|opengraph-image\.tsx'; then
  echo "DRIFT: green token referenced from a component above; green is LIVE-only (add a CSS class under a LIVE selector)"
  fail=1
fi

# 4. Brand logo colours (Spotify green, YouTube red) are allowed on the
#    small service badges only: `--svc-*` may be read only inside a `.svc-badge` rule, and
#    no component may name a brand colour outside it. Declarations are skipped.
svc=$(awk '
  /\/\*/ { incomment = 1 }
  incomment { if ($0 ~ /\*\//) incomment = 0; next }
  /\{[[:space:]]*$/ { sel = $0; sub(/^[[:space:]]+/, "", sel) }
  /var\(--svc-/ { if (sel !~ /^\.svc-badge/) printf "%d: [%s] %s\n", NR, sel, $0 }
' "$css")
if [ -n "$svc" ]; then
  echo "$svc"
  echo "DRIFT: brand service colour (--svc-*) used outside .svc-badge in $css"
  fail=1
fi
if grep -rnE 'var\(--svc-|data-svc=' apps/web/app --include='*.tsx' | grep -vE 'ServiceBadge\.tsx|\.test\.tsx'; then
  echo "DRIFT: brand service colour referenced from a component above; use <ServiceBadge>"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "check_web_drift: clean"
fi
exit $fail
