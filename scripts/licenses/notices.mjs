// Third-party notices: what others made that a WebSfM build hands to its users, with
// each license and notice text. Three sources feed one list:
//
//   - the npm packages the build bundles: vite-plugin.mjs records every module the app
//     and its workers load and maps it to its package;
//   - the Rust crates compiled into the WebAssembly modules: src/wasm/third-party.json,
//     written by cargo.mjs as part of `npm run build:wasm`;
//   - the entries kept by hand in src/core/help/licenses.js: code and tables taken into
//     WebSfM's own source, the learned models and the data.
//
// The build writes the list twice: third-party-licenses.json for About ▸ Licenses and
// THIRD_PARTY_NOTICES.txt, the plain text that travels with every copy of the app.
// Each distinct text is stored once; an entry refers to its texts by id.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A file in a package's root that carries its license, copyright or notices. */
export const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|third[-_]?party[-_]?notices?)([-_.].*)?$/i

// Modules a bundler or plugin writes itself (Rollup's `\0` ids), by the package whose
// code they are.
const VIRTUAL_PACKAGES = [
  [/^vite\//, 'vite'],
  [/^commonjsHelpers/, 'vite'],
  [/^plugin-vue:/, '@vitejs/plugin-vue'],
  [/^virtual:pwa-/, 'vite-plugin-pwa'],
]

/**
 * The package a bundled module belongs to: `{ name, dir }` for a file under
 * node_modules (the innermost package, so a nested copy is its own), `{ name }` for a
 * bundler's own module, null for WebSfM's code.
 */
export function packageOfModuleId(id) {
  const raw = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/')
  const at = raw.lastIndexOf('/node_modules/')
  if (at < 0) {
    for (const [pattern, name] of VIRTUAL_PACKAGES) if (pattern.test(raw)) return { name }
    return null
  }
  const parts = raw.slice(at + '/node_modules/'.length).split('/')
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  if (!name || name.startsWith('.')) return null
  return { name, dir: `${raw.slice(0, at)}/node_modules/${name}` }
}

/** The web page of a package from its package.json `repository` or `homepage`. */
export function packageUrl(pkg) {
  let repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (repo) {
    repo = repo
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/\.git$/, '')
    if (/^github:/.test(repo)) repo = `https://github.com/${repo.slice(7)}`
    else if (/^[\w.-]+\/[\w.-]+$/.test(repo)) repo = `https://github.com/${repo}`
    if (/^https?:\/\//.test(repo)) {
      const dir = typeof pkg.repository === 'object' && pkg.repository.directory
      return dir && /github\.com/.test(repo) ? `${repo}/tree/HEAD/${dir}` : repo
    }
  }
  return pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`
}

/** The SPDX expression of a package.json, including the old `licenses` array. */
export function packageLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license?.type) return pkg.license.type
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ')
  return 'UNKNOWN'
}

/** License files in a directory, as `{ file, text }`, sorted by name. */
export function licenseFilesIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }))
}

/**
 * One npm package as a notice entry. `extraTexts` (repo-relative paths) supply the
 * texts of a package that publishes none (licenses.js PACKAGE_LICENSE_FILES).
 */
export function packageEntry(dir, { root, extraTexts = [] } = {}) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const texts = licenseFilesIn(dir)
  for (const path of extraTexts) texts.push({ file: path, text: readFileSync(join(root, path), 'utf8') })
  return { name: pkg.name, version: pkg.version, license: packageLicense(pkg), url: packageUrl(pkg), texts }
}

/** Where `name` resolves from `fromDir` (Node's lookup: each node_modules up to `root`). */
export function findPackageDir(name, fromDir, root) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root || dirname(dir) === dir) return null
  }
}

/**
 * The packages `names` and everything they depend on at run time (`dependencies`, and
 * the optional ones that are installed), as a Map name@dir → dir.
 */
export function withDependencies(names, root) {
  const found = new Map()
  const visit = (name, fromDir) => {
    const dir = findPackageDir(name, fromDir, root)
    if (!dir || found.has(dir)) return
    found.set(dir, dir)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dir)
  }
  for (const name of names) visit(name, root)
  return found
}

const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/\s+$/, '') + '\n'
export const textId = (text) => createHash('sha256').update(normalize(text)).digest('hex').slice(0, 12)

/**
 * The notices from `groups` ([{ group, note?, items: [{ name, version?, license, url?,
 * use?, notice?, texts: [{ file, text }] }] }]): `doc` for the About dialog, where an
 * item's texts are `{ file, id }` into `doc.texts`, and `txt` for THIRD_PARTY_NOTICES.txt,
 * where each distinct text is printed once at the end and an entry names its number.
 */
export function buildNotices(groups, { title }) {
  const texts = {}
  const numbers = new Map()
  const docGroups = groups.map((g) => ({
    group: g.group,
    ...(g.note ? { note: g.note } : {}),
    items: g.items.map((it) => {
      const refs = (it.texts ?? []).map(({ file, text }) => {
        const id = textId(text)
        if (!texts[id]) {
          texts[id] = normalize(text)
          numbers.set(id, numbers.size + 1)
        }
        return { file, id }
      })
      const { texts: _drop, ...rest } = it
      return { ...rest, texts: refs }
    }),
  }))

  const lines = [
    title,
    '',
    'WebSfM is released under the MIT License (the file LICENSE next to this one). It',
    'includes the software, models and data listed below, which others made and which',
    'keep their own licenses. Each entry names its license; the license and notice',
    'texts follow at the end, each printed once.',
  ]
  for (const g of docGroups) {
    lines.push('', '', `== ${g.group} ==`)
    if (g.note) lines.push('', g.note)
    for (const it of g.items) {
      lines.push('', `${it.name}${it.version ? ` ${it.version}` : ''} (${it.license})`)
      if (it.url) lines.push(`  ${it.url}`)
      if (it.use) lines.push(`  ${it.use}`)
      if (it.notice) lines.push(`  ${it.notice}`)
      for (const ref of it.texts) lines.push(`  ${ref.file}: see text [${numbers.get(ref.id)}]`)
    }
  }
  lines.push('', '', '== License and notice texts ==')
  for (const [id, n] of numbers) lines.push('', `---- [${n}] ----`, '', texts[id].trimEnd())
  return { doc: { title, groups: docGroups, texts }, txt: lines.join('\n') + '\n' }
}
