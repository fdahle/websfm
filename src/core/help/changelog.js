// CHANGELOG.md as data, for Help ▸ What's New and for `npm run release`
// (scripts/release.mjs). The file follows Keep a Changelog:
//
//   ## [Unreleased]
//   ### Added
//   - **Headline.** First sentence, in the user's terms. Then the detail and the
//     evidence (bench numbers), which only the Full view shows.
//
//   ## [0.4.0] — 2026-10-21
//
// An entry is a `- ` line and its indented continuation lines. Its headline is the
// bold text it opens with; without one, the first sentence stands in.

const RELEASE_RE = /^## \[([^\]]+)\](?: — (\d{4}-\d{2}-\d{2}))?(?: — (.+))?\s*$/
export const UNRELEASED = 'Unreleased'

/**
 * @returns {{ version: string, date: string|null, title: string|null, intro: string,
 *   sections: { title: string|null, entries: { markdown: string, headline: string,
 *   summary: string }[] }[] }[]} newest first, as in the file.
 */
export function parseChangelog(md) {
  const releases = []
  let release = null
  let section = null
  let entry = null
  const closeEntry = () => {
    if (entry) section.entries.push(describeEntry(entry.join('\n')))
    entry = null
  }
  for (const line of md.split(/\r?\n/)) {
    const rel = RELEASE_RE.exec(line)
    if (rel) {
      closeEntry()
      release = { version: rel[1], date: rel[2] ?? null, title: rel[3] ?? null, intro: '', sections: [] }
      section = null
      releases.push(release)
    } else if (!release) {
      continue // the file's own preamble
    } else if (line.startsWith('### ')) {
      closeEntry()
      section = { title: line.slice(4).trim(), entries: [] }
      release.sections.push(section)
    } else if (line.startsWith('- ')) {
      closeEntry()
      if (!section) release.sections.push((section = { title: null, entries: [] }))
      entry = [line.slice(2)]
    } else if (entry && (line.startsWith('  ') || line.trim() === '')) {
      entry.push(line.replace(/^ {2}/, ''))
    } else if (line.trim()) {
      closeEntry()
      if (!section) release.intro = release.intro ? `${release.intro}\n${line}` : line
    }
  }
  closeEntry()
  return releases
}

// The first sentence of `text`: up to a . ! or ? followed by a space and a capital,
// a bracket, a backtick or bold, and not inside brackets, bold or code (so "(**New
// here? Open …**)" does not end one). Abbreviations such as "e.g. the" do not either.
export function firstSentence(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const count = (s, t) => s.split(t).length - 1
  for (const m of flat.matchAll(/[.!?](?=\s+[A-Z(`*"“])/g)) {
    const head = flat.slice(0, m.index + 1)
    const closed = count(head, '(') === count(head, ')') && count(head, '**') % 2 === 0 && count(head, '`') % 2 === 0
    if (closed) return head
  }
  return flat
}

function describeEntry(raw) {
  const markdown = raw.trimEnd()
  const bold = /^\*\*(.+?)\*\*\s*/.exec(markdown)
  if (bold) {
    const rest = markdown.slice(bold[0].length)
    const lead = rest ? firstSentence(rest) : ''
    return { markdown, headline: bold[1], summary: lead ? `**${bold[1]}** ${lead}` : `**${bold[1]}**` }
  }
  const lead = firstSentence(markdown)
  return { markdown, headline: lead, summary: lead }
}

export const entryCount = (release) => release.sections.reduce((n, s) => n + s.entries.length, 0)

// ── Versions ──────────────────────────────────────────────────────────────────
// x.y.z with an optional -prerelease ("0.1.0-beta.1"). Unreleased is newer than all.

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v)
  if (!m) throw new Error(`Not a version: "${v}"`)
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? null }
}

export function compareVersions(a, b) {
  if (a === b) return 0
  if (a === UNRELEASED) return 1
  if (b === UNRELEASED) return -1
  const x = parseVersion(a)
  const y = parseVersion(b)
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0 // 1.0.0-beta < 1.0.0
  return x.pre.localeCompare(y.pre, 'en', { numeric: true })
}

// A 0.x version or a pre-release: features and the project format still change between
// versions, so the app shows a Beta badge (BetaBadge.vue).
export function isBetaVersion(v) {
  const { nums, pre } = parseVersion(v)
  return nums[0] === 0 || pre != null
}

// The next version: 'major' | 'minor' | 'patch', or an explicit x.y.z.
export function bumpVersion(current, kind = 'minor') {
  if (!['major', 'minor', 'patch'].includes(kind)) {
    parseVersion(kind)
    if (compareVersions(kind, current) <= 0) throw new Error(`${kind} is not newer than ${current}`)
    return kind
  }
  const [maj, min, pat] = parseVersion(current).nums
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

// The newest released version in the changelog, or null.
export function latestRelease(releases) {
  return releases.find((r) => r.version !== UNRELEASED)?.version ?? null
}

// Entries released after `seenVersion` (Unreleased never counts: it has not shipped).
export function countNewEntries(releases, seenVersion) {
  if (!seenVersion) return 0
  return releases
    .filter((r) => r.version !== UNRELEASED && compareVersions(r.version, seenVersion) > 0)
    .reduce((n, r) => n + entryCount(r), 0)
}

// ── Cutting a release ─────────────────────────────────────────────────────────

// `md` with its Unreleased entries moved under `## [version] — date`, and an empty
// Unreleased above. Throws when there is nothing to release.
export function cutRelease(md, version, date) {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l))
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading')
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end)
  if (!body.some((l) => l.startsWith('- '))) throw new Error('Nothing to release: [Unreleased] has no entries')
  if (parseChangelog(md).some((r) => r.version === version)) throw new Error(`${version} is already in CHANGELOG.md`)
  return [
    ...lines.slice(0, start),
    '## [Unreleased]',
    '',
    `## [${version}] — ${date}`,
    ...body,
    ...lines.slice(end),
  ].join('\n')
}
