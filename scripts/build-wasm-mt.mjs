// The threaded build of crates/reconstruction → src/wasm/reconstruction-mt (crates/README.md
// ▸ Threads). Part of `npm run build:wasm`. It needs nightly Rust with rust-src and the
// wasm32 target (`rustup component add rust-src --toolchain nightly`, `rustup target add
// wasm32-unknown-unknown --toolchain nightly`): the standard library is rebuilt with
// atomics, and the module gets a shared memory of up to 4 GiB that the rayon pool's
// workers share (wasm-bindgen-rayon). The flags are spelled out here, not in
// .cargo/config.toml, because the other crates must stay single-threaded.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const out = 'src/wasm/reconstruction-mt'
const rustflags = [
  '-C', 'target-feature=+atomics,+bulk-memory,+simd128',
  // Recent Rust no longer adds these for +atomics: a shared, imported memory and the
  // TLS / heap symbols wasm-bindgen's thread support reads.
  '-C', 'link-arg=--shared-memory', '-C', 'link-arg=--import-memory', '-C', 'link-arg=--max-memory=4294967296',
  ...['__wasm_init_tls', '__tls_size', '__tls_align', '__tls_base', '__heap_base'].flatMap((s) => ['-C', `link-arg=--export=${s}`]),
].join(' ')

const run = spawnSync('rustup', ['run', 'nightly', 'wasm-pack', 'build', 'crates/reconstruction', '--target', 'web',
  '--out-dir', `../../${out}`, '--', '--features', 'threads', '-Z', 'build-std=panic_abort,std'],
{ stdio: 'inherit', env: { ...process.env, RUSTFLAGS: rustflags } })
if (run.status !== 0) process.exit(run.status ?? 1)
rmSync(`${out}/.gitignore`, { force: true })
