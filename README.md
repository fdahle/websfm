# websfm

Structure-from-Motion in the browser. The heavy numerical work (SIFT feature
detection, descriptor matching, sparse reconstruction) is written in Rust and
compiled to WebAssembly; the UI is Vue + Vite.

## Running the app

The generated WASM bindings in `src/wasm/**` are committed to the repository, so
you do **not** need a Rust toolchain just to run or develop the front end. This
works the same on macOS, Windows, and Linux:

```bash
npm install
npm run dev
```

## Rebuilding the WASM crates

You only need this when you change Rust code under `crates/`. It requires the
Rust toolchain plus `wasm-pack`.

### One-time setup (per machine)

The toolchain installer configures your PATH for whatever OS/shell you're on —
this step is inherently machine-specific and is not something the repo can
provide.

- **macOS / Linux:** install rustup, then `wasm-pack`:
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  cargo install wasm-pack
  ```
  Open a new terminal (or `source "$HOME/.cargo/env"`) so `cargo` is on PATH.

- **Windows:** download and run [`rustup-init.exe`](https://rustup.rs), then in a
  new terminal:
  ```powershell
  cargo install wasm-pack
  ```

Verify on any OS:

```bash
cargo --version
wasm-pack --version
```

`wasm-pack` adds the `wasm32-unknown-unknown` target automatically on first
build; if needed you can add it manually with
`rustup target add wasm32-unknown-unknown`.

### Build

```bash
npm run build:wasm
```

This compiles all three crates — `sift`, `matching`, and `reconstruction` — into
`src/wasm/<crate>/`. Commit the regenerated bindings so other machines (and fresh
clones) keep working without a toolchain.

## Production build

```bash
npm run build
npm run preview
```
