#!/usr/bin/env bash
# Package the extension into dist/keka-time-<version>.zip
#
# The zip is what you share: it is both the "load unpacked" bundle for teammates
# and the exact artifact you upload to the Chrome Web Store.
set -euo pipefail

cd "$(dirname "$0")"

VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
NAME="keka-time-${VERSION}"
OUT="dist/${NAME}.zip"

# Ship only what the extension actually loads — no dotfiles, no build script,
# no stray previews. A junk file in the zip is a Web Store review rejection.
FILES=(
  README.md
  manifest.json
  popup.html
  popup.css
  popup.js
  keka.js
  background.js
  icons/icon-16.png
  icons/icon-32.png
  icons/icon-48.png
  icons/icon-128.png
)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "missing: $f" >&2; exit 1; }
done

# Fail early on a syntax error rather than shipping a broken zip.
if command -v node >/dev/null 2>&1; then
  for f in popup.js keka.js background.js; do
    node --check "$f" >/dev/null 2>&1 || { echo "syntax error: $f" >&2; exit 1; }
  done
fi

python3 -c "import json;json.load(open('manifest.json'))" \
  || { echo "manifest.json is not valid JSON" >&2; exit 1; }

rm -rf dist
mkdir -p dist
zip -q -X "$OUT" "${FILES[@]}"

echo "built $OUT ($(du -h "$OUT" | cut -f1))"
echo "contents:"
zip -sf "$OUT" | sed 's/^/  /'
