#!/usr/bin/env sh
# Build the browser wallet (packages/zcash-web) into apps/web/public/wasm/.
# The page loads it at run time from there, so the web build itself needs no
# Rust toolchain. Without this build the "This browser" choice says it is off.
#
# Needs: the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown),
# wasm-pack, and a clang that can emit WebAssembly for the secp256k1 C code.
# Apple's clang cannot; Homebrew's llvm can (brew install llvm). Linux clang can.
set -eu
cd "$(dirname "$0")/../../.."

if [ -z "${CC_wasm32_unknown_unknown:-}" ]; then
  for c in /opt/homebrew/opt/llvm/bin/clang /usr/local/opt/llvm/bin/clang; do
    if [ -x "$c" ]; then export CC_wasm32_unknown_unknown="$c"; break; fi
  done
fi
if [ -z "${CC_wasm32_unknown_unknown:-}" ] && ! clang --target=wasm32-unknown-unknown -x c -c /dev/null -o /dev/null 2>/dev/null; then
  echo "need a clang with a WebAssembly backend: brew install llvm, or set CC_wasm32_unknown_unknown" >&2
  exit 1
fi
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-$(dirname "${CC_wasm32_unknown_unknown:-$(command -v clang)}")/llvm-ar}"
[ -x "$AR_wasm32_unknown_unknown" ] || unset AR_wasm32_unknown_unknown

profile="${1:-release}"
case "$profile" in
  release) flag="--release" ;;
  dev) flag="--dev" ;;
  *) echo "usage: $0 [release|dev]" >&2; exit 2 ;;
esac

wasm-pack build packages/zcash-web --target web --out-dir ../../apps/web/public/wasm --out-name unpair_zcash $flag --no-pack
rm -f apps/web/public/wasm/.gitignore apps/web/public/wasm/package.json
echo "built apps/web/public/wasm ($profile)"
