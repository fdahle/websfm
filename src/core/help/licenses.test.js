// The hand-kept third-party entries (licenses.js) and what the build reads beside them:
// every license text is in the repository, every model the app can download is covered,
// and the committed Rust crate list has a text for each crate.
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { CRATE_NOTES, INCLUDED } from './licenses.js'
import { MODELS, isRedistributable } from '../models/registry.js'

const ROOT = new URL('../../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8')
const items = INCLUDED.flatMap((g) => g.items)
const crates = JSON.parse(read('src/wasm/third-party.json'))

describe('hand-kept third-party entries', () => {
  it('have a name, a license and a link', () => {
    for (const it of items) {
      expect(it.name, JSON.stringify(it)).toBeTruthy()
      expect(it.license, it.name).toBeTruthy()
      expect(it.url, it.name).toMatch(/^https:\/\//)
    }
  })

  it('point at license texts that exist', () => {
    for (const it of items)
      for (const file of it.textFiles ?? []) expect(read(file).length, `${it.name}: ${file}`).toBeGreaterThan(200)
  })

  it('carry a license text for everything WebSfM distributes, unless it is public domain', () => {
    const bare = items.filter(
      (it) =>
        !it.textFiles?.length &&
        !/^(Public domain|CC0)/.test(it.license) &&
        !(it.models ?? []).every((id) => !isRedistributable(id)),
    )
    expect(bare.map((it) => it.name)).toEqual([])
  })

  it('cover every model the app can download', () => {
    const covered = new Set(items.flatMap((it) => it.models ?? []))
    expect(Object.keys(MODELS).filter((id) => !covered.has(id))).toEqual([])
  })
})

describe('Rust crates in the WebAssembly modules (src/wasm/third-party.json)', () => {
  it('lists the standard library and has a license text for every crate', () => {
    expect(crates.crates[0].name).toBe('Rust standard library')
    const bare = crates.crates.filter((c) => !c.texts.length || c.texts.some((t) => !crates.texts[t.id]))
    expect(bare.map((c) => c.name)).toEqual([])
  })

  it('gives every vendored copy a note on what WebSfM changed, and only crates that exist', () => {
    const names = new Set(crates.crates.map((c) => c.name))
    for (const name of Object.keys(CRATE_NOTES)) expect(names, name).toContain(name)
    for (const c of crates.crates.filter((c) => c.vendored)) expect(CRATE_NOTES[c.name]?.notice, c.name).toBeTruthy()
  })
})

describe('supplied license texts (licenses/packages, licenses/crates)', () => {
  const dirs = ['licenses/packages', 'licenses/crates'].flatMap((base) =>
    readdirSync(new URL(base, ROOT), { withFileTypes: true, recursive: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${e.parentPath ?? e.path}/${e.name}`),
  )

  it('are not empty folders', () => {
    for (const dir of dirs) {
      const files = readdirSync(dir, { withFileTypes: true })
      // A scope folder (@sqlite.org) holds the package folder.
      if (files.length && files.every((f) => f.isDirectory())) continue
      expect(
        files.some((f) => f.isFile()),
        dir,
      ).toBe(true)
    }
  })

  it('for a crate, are in the crate list', () => {
    for (const name of readdirSync(new URL('licenses/crates', ROOT)))
      expect(
        crates.crates.some((c) => c.texts.some((t) => t.file.startsWith(`licenses/crates/${name}/`))),
        name,
      ).toBe(true)
  })

  it('exist for the vendored crate in its own folder', () => {
    expect(existsSync(new URL('crates/mesh/vendor/poisson_reconstruction/LICENSE-MIT', ROOT))).toBe(true)
    expect(existsSync(new URL('crates/mesh/vendor/poisson_reconstruction/LICENSE-APACHE', ROOT))).toBe(true)
  })
})
