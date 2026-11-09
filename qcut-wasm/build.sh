#!/usr/bin/env bash
# Build the .qcut tile codec into web/app/shared/qcut-codec.wasm (low priority, 4 jobs).
#   web/qcut-wasm/build.sh          (needs the wasm32-unknown-unknown target; wasm-opt if present)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${CARGO_TARGET_DIR:=$TEMP/qcut-tw}"
export CARGO_TARGET_DIR CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="-C target-feature=+simd128,+bulk-memory,+sign-ext,+nontrapping-fptoint --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$here=/src"
cd "$here"
nice -n 19 cargo test --release --quiet
nice -n 19 cargo build --release --target wasm32-unknown-unknown
out="$here/../app/shared/qcut-codec.wasm"
src="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/qcut_wasm.wasm"
if command -v wasm-opt >/dev/null; then
  nice -n 19 wasm-opt -O3 --strip-debug --strip-producers --enable-simd --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals "$src" -o "$out"
else
  cp "$src" "$out"
fi
ls -l "$out"
