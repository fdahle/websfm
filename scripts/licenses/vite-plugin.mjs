// The build's third-party notices (notices.mjs): every module the app and its workers
// load is mapped to its npm package, and at the end of the build the packages, the Rust
// crates (src/wasm/third-party.json) and the hand-kept entries (core/help/licenses.js)
// become dist/third-party-licenses.json and dist/THIRD_PARTY_NOTICES.txt.
//
// `transform` sees every module, `?url` assets (the EPSG catalog, SQLite's wasm) and CSS
// (KaTeX, with its fonts) included; a module that tree-shaking later empties still
// counts, which errs towards listing. Workers are separate Rollup builds, so the
// collector goes into `worker.plugins` too; they are bundled while the app's modules
// are transformed, before its generateBundle writes the files.
//
// The dev server serves the same two files, with every runtime dependency of
// package.json in place of the bundled packages, and says so.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CRATE_NOTES, INCLUDED } from '../../src/core/help/licenses.js'
import { buildNotices, packageEntry, packageOfModuleId, withDependencies, findPackageDir } from './notices.mjs'

export const NOTICES_JSON = 'third-party-licenses.json'
export const NOTICES_TXT = 'THIRD_PARTY_NOTICES.txt'

// The service worker's runtime, which vite-plugin-pwa bundles with Workbox's own
// Rollup (no plugin of ours sees it): the modules its generateSW config uses.
const SERVICE_WORKER_PACKAGES = [
  'workbox-core',
  'workbox-precaching',
  'workbox-routing',
  'workbox-strategies',
  'workbox-expiration',
  'workbox-cacheable-response',
]

/** Texts from licenses/packages/<name>/, for a package that publishes none (or not all). */
function suppliedTexts(root, name) {
  const dir = join(root, 'licenses/packages', name)
  return existsSync(dir) ? readdirSync(dir).sort().map((f) => `licenses/packages/${name}/${f}`) : []
}

function packageGroup(root, dirs, ownName) {
  const items = []
  const seen = new Set()
  for (const dir of dirs) {
    const entry = packageEntry(dir, { root, extraTexts: suppliedTexts(root, packageNameAt(dir)) })
    const key = `${entry.name}@${entry.version}`
    if (entry.name === ownName || seen.has(key)) continue
    seen.add(key)
    items.push(entry)
  }
  return items.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

const packageNameAt = (dir) => {
  const parts = dir.replace(/\\/g, '/').split('/node_modules/').pop().split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function rustGroup(root) {
  const doc = JSON.parse(readFileSync(join(root, 'src/wasm/third-party.json'), 'utf8'))
  return doc.crates.map(({ authors: _a, vendored: _v, texts, ...c }) => ({
    ...c,
    ...CRATE_NOTES[c.name],
    texts: texts.map(({ file, id }) => ({ file, text: doc.texts[id] })),
  }))
}

function includedGroups(root) {
  return INCLUDED.map((g) => ({
    group: g.group,
    items: g.items.map(({ textFiles = [], models: _m, ...it }) => ({
      ...it,
      texts: textFiles.map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') })),
    })),
  }))
}

/** The notices from a set of package directories. */
export function makeNotices({ root, version, packageDirs, packagesNote }) {
  const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
  const [code, ...rest] = includedGroups(root)
  return buildNotices(
    [
      {
        group: 'JavaScript packages',
        ...(packagesNote ? { note: packagesNote } : {}),
        items: packageGroup(root, packageDirs, own),
      },
      { group: 'Rust crates (in the WebAssembly modules)', items: rustGroup(root) },
      code,
      ...rest,
    ],
    { title: `WebSfM ${version}: third-party notices` },
  )
}

/** [plugin for the app, plugin factory for `worker.plugins`]. */
export function thirdPartyNotices({ root, version }) {
  const dirs = new Set()
  const missing = new Set()
  const record = (id) => {
    const found = packageOfModuleId(id)
    if (!found) return
    const dir = found.dir ?? findPackageDir(found.name, root, root)
    if (dir && existsSync(join(dir, 'package.json'))) dirs.add(dir)
    else missing.add(found.name)
  }
  const collector = () => ({
    name: 'websfm:collect-packages',
    apply: 'build',
    transform(_code, id) {
      record(id)
    },
  })

  let command
  const app = {
    name: 'websfm:third-party-notices',
    configResolved(config) {
      command = config.command
    },
    transform(_code, id) {
      if (command === 'build') record(id)
    },
    generateBundle() {
      if (command !== 'build') return
      for (const dir of withDependencies(SERVICE_WORKER_PACKAGES, root).keys()) dirs.add(dir)
      if (missing.size) this.warn(`No package directory for: ${[...missing].join(', ')}`)
      const { doc, txt } = makeNotices({ root, version, packageDirs: [...dirs] })
      // The generated groups; licenses.test.js checks the hand-kept entries.
      const bare = doc.groups
        .slice(0, 2)
        .flatMap((g) => g.items)
        .filter((it) => !it.texts.length)
      if (bare.length)
        this.warn(
          `No license text for ${bare.map((it) => it.name).join(', ')}: add it under licenses/packages/<name>/ ` +
            'or licenses/crates/<name>/',
        )
      this.emitFile({ type: 'asset', fileName: NOTICES_JSON, source: JSON.stringify(doc) })
      this.emitFile({ type: 'asset', fileName: NOTICES_TXT, source: txt })
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        const want = path.endsWith(`/${NOTICES_JSON}`) ? 'json' : path.endsWith(`/${NOTICES_TXT}`) ? 'txt' : null
        if (!want) return next()
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        const { doc, txt } = makeNotices({
          root,
          version,
          packageDirs: [...withDependencies(Object.keys(pkg.dependencies ?? {}), root).keys()],
          packagesNote:
            'Development server: every run-time dependency in package.json. A build lists the packages it bundles.',
        })
        res.setHeader('Content-Type', want === 'json' ? 'application/json' : 'text/plain; charset=utf-8')
        res.end(want === 'json' ? JSON.stringify(doc) : txt)
      })
    },
  }
  return [app, collector]
}
