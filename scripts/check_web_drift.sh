#!/usr/bin/env bash
# check_web_drift.sh — CSS/brand drift checks born from real failures.
# Rule 1 protects against: renaming a @keyframes and orphaning animation refs
#   (docs/failures/css-keyframe-rename-orphans.md — hero subcopy/CTA went invisible).
# Rule 3 protects against: green leaking onto actions (docs: green = LIVE only; violet
#   --color-accent is every action and focus; #325 found three green links).
# Rule 2 protects against: off-palette Tailwind color utilities on a violet-only brand
#   (docs/failures/subagent-offbrand-color-drift.md — orange-300 shipped by a builder agent).
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

css=apps/web/app/globals.css
axes_css=apps/web/app/brand-axes.css

# 1. Every `animation: <name>` in globals.css must have a matching @keyframes.
refs=$(cat "$css" "$axes_css" | grep -oE 'animation: [a-zA-Z0-9-]+'  | awk '{print $2}' | sort -u | grep -v '^none$' || true)
for name in $refs; do
  if ! grep -q "@keyframes $name" "$css" "$axes_css"; then
    echo "DRIFT: animation '$name' referenced in $css or $axes_css but no '@keyframes $name' exists"
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
LIVE_SELECTORS='^\.eyebrow\.is-live|^\.room-card__live|^\.room-card__dot|^\.eq span|^\.queue-thumb-eq'
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
# brand-axes.css (preview overrides, #325) has no LIVE surface of its own: no green at all.
if grep -nE 'color-accent-2|logo-core' "$axes_css" | grep -vE '^[0-9]+:[[:space:]]*(/\*|\*)'; then
  echo "DRIFT: green used in $axes_css; overrides must not touch green (LIVE selectors live in globals.css)"
  fail=1
fi
if grep -rnE 'color-accent-2|logo-core' apps/web/app --include='*.tsx' \
  | grep -vE 'Logo\.tsx|\.test\.tsx|opengraph-image\.tsx|og/ogCard\.tsx'; then
  echo "DRIFT: green token referenced from a component above; green is LIVE-only (add a CSS class under a LIVE selector)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "check_web_drift: clean"
fi
exit $fail
