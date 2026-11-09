import { describe, expect, it } from 'vitest'
import { buildNotices, packageLicense, packageOfModuleId, packageUrl, textId } from './notices.mjs'
import { htmlToText, shippedCrates } from './cargo.mjs'

describe('packageOfModuleId', () => {
  it('names the package of a file under node_modules', () => {
    expect(packageOfModuleId('/w/node_modules/three/build/three.module.js')).toEqual({
      name: 'three',
      dir: '/w/node_modules/three',
    })
  })
  it('keeps the scope of a scoped package and drops a query', () => {
    expect(packageOfModuleId('/w/node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm?url')).toEqual({
      name: '@sqlite.org/sqlite-wasm',
      dir: '/w/node_modules/@sqlite.org/sqlite-wasm',
    })
  })
  it('takes the innermost copy of a nested package', () => {
    expect(packageOfModuleId('/w/node_modules/ol/node_modules/geotiff/dist/a.js').dir).toBe(
      '/w/node_modules/ol/node_modules/geotiff',
    )
  })
  it('reads Windows paths', () => {
    expect(packageOfModuleId('C:\\w\\node_modules\\vue\\index.js').name).toBe('vue')
  })
  it("maps a bundler's own modules to the package that writes them", () => {
    expect(packageOfModuleId('\0vite/preload-helper.js')).toEqual({ name: 'vite' })
    expect(packageOfModuleId('\0plugin-vue:export-helper')).toEqual({ name: '@vitejs/plugin-vue' })
  })
  it("is null for WebSfM's own code", () => {
    expect(packageOfModuleId('/w/src/core/sfm/geometry.js')).toBeNull()
    expect(packageOfModuleId('\0some-other-virtual')).toBeNull()
  })
})

describe('packageUrl and packageLicense', () => {
  it('turns a git URL into the web page', () => {
    expect(packageUrl({ name: 'a', repository: { url: 'git+https://github.com/o/a.git' } })).toBe(
      'https://github.com/o/a',
    )
    expect(packageUrl({ name: 'a', repository: 'git@github.com:o/a.git' })).toBe('https://github.com/o/a')
  })
  it('expands the owner/repo and github: shorthands', () => {
    expect(packageUrl({ name: 'a', repository: 'o/a' })).toBe('https://github.com/o/a')
    expect(packageUrl({ name: 'a', repository: 'github:o/a' })).toBe('https://github.com/o/a')
  })
  it('points into a monorepo at the package directory', () => {
    const pkg = { name: 'a', repository: { url: 'https://github.com/o/mono.git', directory: 'packages/a' } }
    expect(packageUrl(pkg)).toBe('https://github.com/o/mono/tree/HEAD/packages/a')
  })
  it('falls back to the homepage, then to npm', () => {
    expect(packageUrl({ name: 'a', homepage: 'https://a.dev' })).toBe('https://a.dev')
    expect(packageUrl({ name: '@s/a' })).toBe('https://www.npmjs.com/package/@s/a')
  })
  it('reads the old licenses array', () => {
    expect(packageLicense({ license: 'MIT' })).toBe('MIT')
    expect(packageLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0')
    expect(packageLicense({})).toBe('UNKNOWN')
  })
})

describe('buildNotices', () => {
  const APACHE = 'Apache License\nVersion 2.0\n'
  const groups = [
    {
      group: 'Packages',
      items: [
        { name: 'a', version: '1.0.0', license: 'Apache-2.0', texts: [{ file: 'LICENSE', text: APACHE }] },
        // The same text with Windows line ends and a trailing blank line.
        { name: 'b', version: '2.0.0', license: 'Apache-2.0', texts: [{ file: 'LICENSE', text: 'Apache License\r\nVersion 2.0\r\n\r\n' }] },
        { name: 'c', license: 'MIT', url: 'https://c', notice: 'Thanks', texts: [{ file: 'LICENSE', text: 'MIT c' }] },
      ],
    },
  ]
  const { doc, txt } = buildNotices(groups, { title: 'T' })

  it('stores a text once, however its lines end', () => {
    expect(Object.keys(doc.texts)).toHaveLength(2)
    expect(doc.groups[0].items[0].texts[0].id).toBe(doc.groups[0].items[1].texts[0].id)
    expect(doc.texts[textId(APACHE)]).toBe(APACHE)
  })
  it('keeps every entry and its fields, with texts as references', () => {
    const c = doc.groups[0].items[2]
    expect(c).toMatchObject({ name: 'c', license: 'MIT', url: 'https://c', notice: 'Thanks' })
    expect(c.texts).toEqual([{ file: 'LICENSE', id: textId('MIT c') }])
  })
  it('prints each text once in the plain text, and each entry names its number', () => {
    expect(txt.split('Apache License').length - 1).toBe(1)
    expect(txt).toContain('a 1.0.0 (Apache-2.0)\n  LICENSE: see text [1]')
    expect(txt).toContain('b 2.0.0 (Apache-2.0)\n  LICENSE: see text [1]')
    expect(txt).toContain('c (MIT)\n  https://c\n  Thanks\n  LICENSE: see text [2]')
    expect(txt).toContain('---- [2] ----\n\nMIT c')
  })
})

describe('shippedCrates', () => {
  const pkg = (id, { procMacro = false, path = `/reg/${id}/Cargo.toml` } = {}) => ({
    id,
    name: id,
    version: '1.0.0',
    manifest_path: path,
    targets: [{ kind: [procMacro ? 'proc-macro' : 'lib'] }],
  })
  const dep = (id, kind = null) => ({ pkg: id, dep_kinds: [{ kind }] })
  const meta = {
    workspace_members: ['own', 'vendored'],
    packages: [
      pkg('own', { path: '/w/crates/own/Cargo.toml' }),
      pkg('vendored', { path: '/w/crates/own/vendor/vendored/Cargo.toml' }),
      pkg('lib'),
      pkg('deep'),
      pkg('macro', { procMacro: true }),
      pkg('macro-only'),
      pkg('builder'),
      pkg('tester'),
    ],
    resolve: {
      nodes: [
        { id: 'own', deps: [dep('vendored'), dep('macro'), dep('builder', 'build'), dep('tester', 'dev')] },
        { id: 'vendored', deps: [dep('lib')] },
        { id: 'lib', deps: [dep('deep')] },
        { id: 'deep', deps: [] },
        { id: 'macro', deps: [dep('macro-only')] },
        { id: 'macro-only', deps: [] },
      ],
    },
  }
  const names = shippedCrates(meta).map((p) => p.name)

  it('lists what normal dependencies reach, through a vendored copy too', () => {
    expect(names).toEqual(['deep', 'lib', 'vendored'])
  })
  it('leaves out our own crates, build and dev dependencies, and procedural macros with their dependencies', () => {
    for (const name of ['own', 'builder', 'tester', 'macro', 'macro-only']) expect(names).not.toContain(name)
  })
})

describe('htmlToText', () => {
  it('keeps the words and line breaks of the toolchain notice', () => {
    const html =
      '<html><head><title>x</title></head><body><h1>Notices</h1><p>A &amp; B &lt;c&gt;</p><ul><li>one</li><li>two</li></ul></body></html>'
    expect(htmlToText(html)).toBe('Notices\nA & B <c>\n- one\n- two')
  })
})
