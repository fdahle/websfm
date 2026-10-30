#!/usr/bin/env bash
# Playwright's WebKit on Linux needs a few system libraries that `npx playwright
# install-deps` installs with root. Without root, this fetches the Debian/Ubuntu
# packages with `apt-get download` and unpacks their libraries into the browser's own
# sys/lib folder, which its launcher puts on the library path. Run it again after a
# Playwright update installs a new WebKit build.
set -euo pipefail
PACKAGES=(libmanette-0.2-0 libbacktrace0 libhidapi-hidraw0)
cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && apt-get download "${PACKAGES[@]}")
for deb in "$tmp"/*.deb; do dpkg-deb -x "$deb" "$tmp/root"; done
found=0
for dir in "$cache"/webkit-*/minibrowser-*/sys/lib; do
  [ -d "$dir" ] || continue
  cp -a "$tmp"/root/usr/lib/*/lib*.so* "$dir"/
  echo "libraries copied to $dir"
  found=1
done
[ "$found" = 1 ] || { echo "no WebKit under $cache: run npx playwright install webkit" >&2; exit 1; }
