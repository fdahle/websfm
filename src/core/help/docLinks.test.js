// The repository's own documentation (README, ARCHITECTURE, AGENTS, CONTRIBUTING,
// docs/, the folder READMEs) points at files: relative links, and paths in backticks
// such as `core/products/dem.js`. A rename or a deleted module leaves those behind, and
// a reader (or an agent) who follows one finds nothing. This test resolves each of them.
//
// A backticked path may be written from the repo root, from the document's folder, or
// from `src/` (ARCHITECTURE says `core/…`, `workers/…`); a path that ends a tracked
// file's path also counts, and so does a path git ignores (`dist/`, `bench-out/`,
// `public/models/`: made by the build, the bench or a fetch script). A bare folder name
// (`matches/`) is too vague to check; a folder needs two parts (`core/stepEffects/`).
// The in-app help (src/guide/, src/glossary/) has its own link
// tests (glossary.test.js, guide.test.js); CHANGELOG.md is history and names old files.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = new URL('../../../', import.meta.url)
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim().split('\n')

const tracked = new Set(git('ls-files'))
const dirs = new Set()
for (const f of tracked) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d)
// On disk counts too: a file made in this change is not in git until it is added.
const exists = (p) => tracked.has(p) || dirs.has(p.replace(/\/$/, '')) || existsSync(new URL(p, root))
const ignored = (p) => {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: root })
    return true
  } catch {
    return false
  }
}
const trackedList = [...tracked]
const endsATrackedPath = (p) => {
  const tail = '/' + p.replace(/\/$/, '')
  return trackedList.some((f) => ('/' + f).endsWith(tail) || ('/' + f).includes(tail + '/'))
}

// Paths in these files are not repository paths: the files inside a saved project.
const BACKTICKS_ARE_NOT_REPO_PATHS = new Set(['docs/project-format.md'])

const docs = git('ls-files', '*.md').filter(
  (f) =>
    !/^(licenses|src\/guide|src\/glossary)\//.test(f) &&
    !f.includes('/vendor/') &&
    !f.startsWith('tests/fixtures/') &&
    f !== 'CHANGELOG.md',
)

const PATH_IN_BACKTICKS =
  /`((?:[\w.-]+\/)+(?:[\w.-]+\.(?:js|mjs|cjs|ts|vue|rs|md|json|py|wgsl|toml|sh|yml|html|css)|))`/g

describe('file references in the documentation', () => {
  const broken = []
  for (const doc of docs) {
    const text = readFileSync(new URL(doc, root), 'utf8')
    const dir = path.posix.dirname(doc)
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1]
      if (/^[a-z][\w+.-]*:/i.test(target)) continue // http:, mailto:, help: …
      const resolved = path.posix.normalize(path.posix.join(dir, decodeURI(target)))
      if (!exists(resolved)) broken.push(`${doc}: link ${target}`)
    }
    if (BACKTICKS_ARE_NOT_REPO_PATHS.has(doc)) continue
    for (const m of text.matchAll(PATH_IN_BACKTICKS)) {
      const p = m[1]
      if (p.endsWith('/') && p.split('/').length < 3) continue // `matches/`: a bare folder name
      const candidates = [p, path.posix.join(dir, p), path.posix.join('src', p)].map((c) => path.posix.normalize(c))
      if (!candidates.some(exists) && !endsATrackedPath(p) && !candidates.some(ignored))
        broken.push(`${doc}: path \`${p}\``)
    }
  }

  it('all resolve to a file or folder in the repository', () => {
    expect(broken).toEqual([])
  })

  it('cover the documents they should (a guard on the file list above)', () => {
    for (const d of [
      'README.md',
      'ARCHITECTURE.md',
      'AGENTS.md',
      'CONTRIBUTING.md',
      'docs/conventions.md',
      'docs/METHODS.md',
    ]) {
      expect(docs).toContain(d)
    }
  })
})
