# qc-wasm

The Rust/WebAssembly core of QuickCut Video. It runs in a Web Worker and does the container work
that WebCodecs does not:

- **Probe**: open an MP4, MOV, MKV or WebM through a synchronous reader (a multi-GB file is never
  loaded at once), describe its tracks and list its samples.
- **Instant cut**: lossless cut and join of MP4/MOV files by copying compressed samples
  (`Media.instant`, or `Media.instant_layout` for a plan the page copies itself, moov first).
- **Mux**: put WebCodecs-encoded frames into MP4/MOV (H.264, HEVC, AV1 + AAC, Opus, PCM) or
  WebM/MKV (VP8/VP9/AV1 + Opus, AAC, PCM).
- **Stretch**: change audio speed without changing pitch (WSOLA).

Source: `src/core.rs` (plain Rust, no JS), `src/lib.rs` (the wasm-bindgen API), `src/lossless.rs`
(the Instant cutter), `src/tests.rs`.

## Build

Needs rustup with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` 0.2.129 and binaryen's
`wasm-opt`.

```sh
./build.sh                                   # writes ./pkg/qc_wasm.js and qc_wasm_bg.wasm
QC_PKG_OUT=../app/video/pkg ./build.sh       # or straight into the web app
```

Environment: `QC_TOOLCHAIN` (default `1.98.0`), `CARGO_TARGET_DIR` (default `./target`),
`CARGO_BUILD_JOBS` (default 4), `QC_NICE=0` to skip the low-priority wrapper.

## Test

```sh
cargo +1.98.0 test
```

## Dependencies

`craft-media` (storytold/craft-libs) and `filmcraft-audio-dsp` (storytold/filmcraft) are Git
dependencies pinned to exact commits in `Cargo.toml`; a clean clone builds with nothing else.
To update, change the `rev` values, run the tests and rebuild.

## License

MIT OR Apache-2.0, see `LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE`.
