// The Memory64 build of crates/mesh → src/wasm/mesh-64 (crates/README.md ▸ Memory64). Part
// of `npm run build:wasm`. The 32-bit build's heap stops at 4 GiB; this one's at 16 GiB, for
// a Poisson solve that does not fit (workers/ops/mesh.js picks it). It needs nightly Rust
// with rust-src (`rustup component add rust-src --toolchain nightly`): wasm64 has no
// prebuilt standard library, so it is rebuilt (-Z build-std), and wasm-pack does not take
// the target, so cargo and wasm-bindgen run directly. wasm-bindgen is the CLI of the
// version in Cargo.lock: on PATH, or the copy wasm-pack downloaded for the other builds.
// No simd128: the `wide` crate under nalgebra assumes wasm32 when SIMD is on, and the
// solver gains nothing from it (Poisson 100 k points: 26.0 s without, 25.2 s with).
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const lock = readFileSync('crates/Cargo.lock', 'utf8')
const version = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1]
const versionOf = (bin) => spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout?.trim().split(' ')[1]
const cache = join(homedir(), '.cache', '.wasm-pack')
const candidates = [
  'wasm-bindgen',
  ...(existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => d.startsWith('wasm-bindgen-'))
        .map((d) => join(cache, d, 'wasm-bindgen'))
    : []),
]
const bindgen = candidates.find((bin) => versionOf(bin) === version)
if (!bindgen) {
  console.error(`build-wasm64: no wasm-bindgen ${version} (cargo install wasm-bindgen-cli --version ${version})`)
  process.exit(1)
}

for (const crate of ['mesh']) {
  const out = `src/wasm/${crate}-64`
  const build = spawnSync(
    'cargo',
    [
      '+nightly',
      'build',
      '--release',
      '-p',
      crate,
      '--target',
      'wasm64-unknown-unknown',
      '-Z',
      'build-std=panic_abort,std',
    ],
    { cwd: 'crates', stdio: 'inherit', env: { ...process.env, RUSTFLAGS: '' } },
  )
  if (build.status !== 0) process.exit(build.status ?? 1)
  const wasm = `crates/target/wasm64-unknown-unknown/release/${crate}.wasm`
  const gen = spawnSync(bindgen, ['--target', 'web', '--out-dir', out, wasm], { stdio: 'inherit' })
  if (gen.status !== 0) process.exit(gen.status ?? 1)
  rmSync(`${out}/.gitignore`, { force: true })
}
