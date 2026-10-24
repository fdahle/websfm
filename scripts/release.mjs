// Cut a release: move CHANGELOG.md's [Unreleased] entries under a new version with
// today's date, set that version in package.json (and package-lock.json), commit
// those files and tag the commit `v<version>`. Nothing is pushed. Run it for every
// release of websfm.app (docs/development.md ▸ Releases), so the version
// in About and the dates in Help ▸ What's New match what is live. Pushing the tag
// deploys websfm.app (.github/workflows/verify.yml ▸ deploy).
//
//   npm run release                 # 0.4.0 → 0.5.0
//   npm run release -- patch        # 0.4.0 → 0.4.1  (also: major, or an exact 1.0.0)
//   npm run release -- --dry-run    # show what would happen, change nothing
//
// It first lists the feat / fix / perf commits since the last tag, as a checklist:
// a user-visible change among them without a changelog entry should get one first.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { bumpVersion, cutRelease } from '../src/core/help/changelog.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const kind = args.find((a) => !a.startsWith('--')) ?? 'minor'

const root = new URL('../', import.meta.url)
const FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json']
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trimEnd()

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

// Only the release files must be clean; other work in progress may stay uncommitted.
const dirty = git('status', '--porcelain', '--', ...FILES)
if (dirty) fail(`commit or stash these first:\n${dirty}`)

const pkgUrl = new URL('package.json', root)
const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'))
const version = bumpVersion(pkg.version, kind)
const date = new Date().toISOString().slice(0, 10)
const tag = `v${version}`
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`)

const changelogUrl = new URL('CHANGELOG.md', root)
const changelog = cutRelease(await readFile(changelogUrl, 'utf8'), version, date)

let since = ''
try {
  since = git('describe', '--tags', '--abbrev=0', '--match', 'v*')
} catch {
  // no release tag yet: list nothing rather than the whole history
}
if (since) {
  const log = git('log', `${since}..HEAD`, '--format=%h %s', '-E', '--grep', '^(feat|fix|perf)(\\(|!|:)')
  console.log(`feat / fix / perf commits since ${since}: is each one in the changelog, if a user would notice it?`)
  console.log(log ? log.replace(/^/gm, '  ') : '  (none)')
  console.log()
}

console.log(`${pkg.version} → ${version} (${date}), tag ${tag}`)
if (dryRun) {
  console.log('Dry run: nothing changed.')
  process.exit(0)
}

await writeFile(changelogUrl, changelog)
pkg.version = version
await writeFile(pkgUrl, `${JSON.stringify(pkg, null, 2)}\n`)
const lockUrl = new URL('package-lock.json', root)
const lock = JSON.parse(await readFile(lockUrl, 'utf8'))
lock.version = version
if (lock.packages?.['']) lock.packages[''].version = version
await writeFile(lockUrl, `${JSON.stringify(lock, null, 2)}\n`)

git('commit', '--quiet', '-m', `release: ${tag}`, '--', ...FILES)
git('tag', '-a', tag, '-m', `WebSfM ${version}`)
console.log(`Committed and tagged ${tag}. Push with: git push && git push origin ${tag}`)
console.log('Pushing the tag deploys websfm.app (GitHub Actions ▸ deploy).')
