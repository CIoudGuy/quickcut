#!/usr/bin/env bash
# Build qc-wasm for the browser: cargo (wasm32) -> wasm-bindgen -> wasm-opt.
#
#   ./build.sh                      output in ./pkg (qc_wasm.js, qc_wasm_bg.wasm)
#   QC_PKG_OUT=../app/video/pkg ./build.sh
#
# Needs: rustup with the wasm32-unknown-unknown target, wasm-bindgen-cli 0.2.129 (the version
# pinned in Cargo.toml), and binaryen's wasm-opt. Optional env vars:
#   QC_TOOLCHAIN     Rust toolchain (default 1.98.0)
#   CARGO_TARGET_DIR build directory (default ./target)
#   CARGO_BUILD_JOBS parallel jobs (default 4)
#   QC_NICE          set to 0 to skip running the build at low priority
# Tests: cargo +1.98.0 test
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${QC_PKG_OUT:-$here/pkg}"
toolchain="${QC_TOOLCHAIN:-1.98.0}"
: "${CARGO_TARGET_DIR:=$here/target}"
export CARGO_TARGET_DIR CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
# --remap-path-prefix keeps the build machine's folders out of the wasm (panic locations)
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="-C target-feature=+simd128,+bulk-memory --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$here=/src"
low=""
if [ "${QC_NICE:-1}" != "0" ] && command -v nice >/dev/null 2>&1; then low="nice -n 19"; fi
(cd "$here" && $low cargo +"$toolchain" build --release --target wasm32-unknown-unknown --lib)
rm -rf "$out"; mkdir -p "$out"
wasm-bindgen --target web --no-typescript --out-dir "$out" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/qc_wasm.wasm"
$low wasm-opt -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals --enable-reference-types --enable-multivalue "$out/qc_wasm_bg.wasm" -o "$out/qc_wasm_bg.wasm.opt"
mv "$out/qc_wasm_bg.wasm.opt" "$out/qc_wasm_bg.wasm"
ls -la "$out"
