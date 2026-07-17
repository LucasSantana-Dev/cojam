#!/usr/bin/env bash
# check_web_drift.sh — CSS/brand drift checks born from real failures.
# Rule 1 protects against: renaming a @keyframes and orphaning animation refs
#   (docs/failures/css-keyframe-rename-orphans.md — hero subcopy/CTA went invisible).
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

if [ "$fail" -eq 0 ]; then
  echo "check_web_drift: clean"
fi
exit $fail
