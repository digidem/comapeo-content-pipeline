#!/usr/bin/env bash
# sync-to-comapeo-docs.sh
# Run docs:pull and rsync output into comapeo-docs, then build.
set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_DIR="${DOCS_DIR:-$PIPELINE_DIR/../comapeo-docs}"
TEMP_OUT="${TEMP_OUT:-/tmp/comapeo-docs-sync}"

echo "=== Running docs:pull ==="
cd "$PIPELINE_DIR"
source .env 2>/dev/null || true

bun src/cli/index.ts docs:pull \
  --input ./output/manifest.json \
  --input-dir ./output \
  --out "$TEMP_OUT" \
  --all \
  --clean-orphans

echo ""
echo "=== Syncing to comapeo-docs ==="
mkdir -p "$DOCS_DIR"/docs "$DOCS_DIR"/i18n
rsync -av --delete "$TEMP_OUT/docs/" "$DOCS_DIR/docs/"
rsync -av --delete "$TEMP_OUT/i18n/" "$DOCS_DIR/i18n/"

echo ""
echo "=== Building Docusaurus ==="
cd "$DOCS_DIR"
rm -rf .docusaurus build
npx docusaurus build

echo ""
echo "=== Done ==="
echo "Site built to: $DOCS_DIR/build"
echo "Run: cd $DOCS_DIR && python3 -m http.server 8765 --directory build"
