#!/usr/bin/env bash
# Downloads, verifies, and unpacks the prebuilt looney-checks engine for this OS/arch.
# v0.3.1+ ships onedir bundles as archives (they start in ~1s vs ~30s for the
# old onefile single-exe builds).
set -euo pipefail

VERSION="${LOONEY_VERSION:-0.3.1}"
REPO="Renderdragonorg/looney-checks"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      x86_64) platform="macos-x86_64" ;;
      arm64)  platform="macos-aarch64" ;;
      *) echo "Unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac
    archive="tar.gz"
    ;;
  Linux)
    case "$arch" in
      x86_64) platform="linux-x86_64" ;;
      aarch64|arm64) platform="linux-aarch64" ;;
      *) echo "Unsupported Linux arch: $arch" >&2; exit 1 ;;
    esac
    archive="tar.gz"
    ;;
  *)
    echo "Unsupported OS: $os (use the -windows-x86_64.zip asset on Windows)" >&2
    exit 1
    ;;
esac

asset="music-copyright-checker-${VERSION}-${platform}.${archive}"
target="$DEST/music-copyright-checker-${VERSION}-${platform}"

mkdir -p "$DEST"
echo "Downloading $asset (v$VERSION)..."
gh release download "v$VERSION" -R "$REPO" -p "$asset" -p "SHA256SUMS" -D "$DEST" --clobber

echo "Verifying checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$DEST" && grep "$asset" SHA256SUMS > .sha256.tmp && sha256sum -c .sha256.tmp && rm .sha256.tmp )
else
  ( cd "$DEST" && grep "$asset" SHA256SUMS > .sha256.tmp && shasum -a 256 -c .sha256.tmp && rm .sha256.tmp )
fi

echo "Unpacking..."
rm -rf "$target"
mkdir -p "$target"
tar -xzf "$DEST/$asset" -C "$target" --strip-components=1
rm -f "$DEST/$asset"

chmod +x "$target/music-copyright-checker"
if [ "$os" = "Darwin" ]; then
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
fi

echo "Engine ready: $target/music-copyright-checker"
