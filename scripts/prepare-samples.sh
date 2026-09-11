#!/usr/bin/env bash
# Convierte las imágenes de prueba de img/ a PNG en samples/ (macOS sips). Ambas carpetas están en .gitignore.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p samples
for f in img/*; do
  base="$(basename "${f%.*}")"
  short="$(echo "$base" | cut -c1-24 | tr -c 'A-Za-z0-9_.\n' '_')"
  sips -s format png "$f" --out "samples/$short.png" >/dev/null && echo "ok samples/$short.png"
done
