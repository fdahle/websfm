// The Rust crates compiled into WebSfM's WebAssembly modules, with their license texts:
// src/wasm/third-party.json, which the build merges into the third-party notices
// (notices.mjs). `npm run build:wasm` runs this after the modules are built, so the list
// is committed with them and a deploy needs no Rust toolchain.
//
//   node scripts/licenses/cargo.mjs           write src/wasm/third-party.json
//   node scripts/licenses/cargo.mjs --check   fail when the crates differ from Cargo.lock
//
// A crate counts when a workspace crate reaches it through normal dependencies on
// wasm32 with every feature on (the threaded reconstruction build turns on `rayon`).
// Build scripts and procedural macros run in the compiler and leave no code in the
// module, so neither they nor what only they depend on is listed. The standard library
// is compiled into every module and is listed first, with the toolchain's own notice.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { licenseFilesIn, textId } from './notices.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = join(ROOT, 'src/wasm/third-party.json')

/**
 * The packages of `meta` (cargo metadata) whose code ends up in a workspace crate's
 * module. A copy kept under a `vendor/` folder is someone else's crate although Cargo
 * makes it a workspace member (a path dependency inside the workspace directory is one).
 */
export function shippedCrates(meta) {
  const packages = new Map(meta.packages.map((p) => [p.id, p]))
  const isVendored = (p) => /[/\\]vendor[/\\]/.test(p.manifest_path)
  const members = new Set(meta.workspace_members.filter((id) => !isVendored(packages.get(id))))
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]))
  const isProcMacro = (p) => p.targets.some((t) => t.kind.includes('proc-macro'))
  const seen = new Set()
  const queue = [...members]
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue
      if (isProcMacro(packages.get(dep.pkg))) continue
      queue.push(dep.pkg)
    }
  }
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => packages.get(id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

/** Plain text of the toolchain's COPYRIGHT-library.html. */
export function htmlToText(html) {
  const body = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/h\d|\/li|\/div|\/tr|\/pre)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(body)
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function standardLibrary() {
  const sysroot = execFileSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).trim()
  const version = execFileSync('rustc', ['--version'], { encoding: 'utf8' }).split(' ')[1]
  const doc = join(sysroot, 'share/doc/rust')
  const texts = []
  const copyright = join(doc, 'COPYRIGHT-library.html')
  if (existsSync(copyright)) texts.push({ file: 'COPYRIGHT-library', text: htmlToText(readFileSync(copyright, 'utf8')) })
  for (const file of ['MIT.txt', 'Apache-2.0.txt']) {
    const path = join(doc, 'licenses', file)
    if (existsSync(path)) texts.push({ file: `licenses/${file}`, text: readFileSync(path, 'utf8') })
  }
  if (!texts.length) throw new Error(`No license files in ${doc}: install the toolchain's rust-docs component`)
  return {
    name: 'Rust standard library',
    version,
    license: 'MIT OR Apache-2.0',
    url: 'https://github.com/rust-lang/rust',
    use: 'Compiled into every WebAssembly module',
    texts,
  }
}

// A crate that publishes no license text gets it from licenses/crates/<name>/ (the
// upstream repository's files, or a note on which of its licenses applies).
function crateEntry(p) {
  const dir = dirname(p.manifest_path)
  const texts = licenseFilesIn(dir)
  if (p.license_file && !texts.some((t) => t.file === p.license_file)) {
    const path = join(dir, p.license_file)
    if (existsSync(path)) texts.push({ file: p.license_file, text: readFileSync(path, 'utf8') })
  }
  const supplied = join(ROOT, 'licenses/crates', p.name)
  if (existsSync(supplied))
    for (const file of readdirSync(supplied).sort())
      texts.push({ file: `licenses/crates/${p.name}/${file}`, text: readFileSync(join(supplied, file), 'utf8') })
  return {
    name: p.name,
    version: p.version,
    license: p.license ?? `see ${p.license_file}`,
    url: p.repository || p.homepage || `https://crates.io/crates/${p.name}`,
    ...(p.authors?.length ? { authors: p.authors } : {}),
    // A copy kept in this repository (crates/*/vendor/), changed for WebSfM.
    ...(p.source === null ? { vendored: true } : {}),
    texts,
  }
}

/** The committed form: each item's texts as { file, id }, the texts once in `texts`. */
function toDocument(items) {
  const texts = {}
  const crates = items.map((it) => ({
    ...it,
    texts: it.texts.map(({ file, text }) => {
      const id = textId(text)
      texts[id] = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n'
      return { file, id }
    }),
  }))
  return { crates, texts }
}

// Run as a script (not when a test imports the functions above).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const meta = JSON.parse(
    execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version=1',
        '--all-features',
        '--filter-platform=wasm32-unknown-unknown',
        `--manifest-path=${join(ROOT, 'crates/Cargo.toml')}`,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 30 },
    ),
  )
  const crates = shippedCrates(meta).map(crateEntry)
  const key = (c) => `${c.name} ${c.version} ${c.license}`

  if (process.argv.includes('--check')) {
    const committed = JSON.parse(readFileSync(OUT, 'utf8')).crates.filter((c) => c.name !== 'Rust standard library')
    const want = crates.map(key).join('\n')
    const have = committed.map(key).join('\n')
    if (want !== have) {
      console.error('src/wasm/third-party.json lists other crates than Cargo.lock. Run npm run build:wasm.')
      process.exit(1)
    }
    console.log(`src/wasm/third-party.json matches Cargo.lock (${crates.length} crates)`)
  } else {
    const missing = crates.filter((c) => !c.texts.length).map((c) => `${c.name} ${c.version}`)
    if (missing.length) console.warn(`No license file in: ${missing.join(', ')}`)
    writeFileSync(OUT, JSON.stringify(toDocument([standardLibrary(), ...crates])) + '\n')
    console.log(`Wrote src/wasm/third-party.json: the standard library and ${crates.length} crates`)
  }
}
