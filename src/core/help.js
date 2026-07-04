// In-app glossary/help content: markdown files under src/help/, each with a
// small frontmatter block (id/title/summary) and a markdown body. Pure module —
// no Vue/DOM — so parsing is unit-testable and the loader can run in the worker
// or main thread alike. See src/help/reprojection-error.md for the schema.
import { Marked } from 'marked'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

// Strip a leading HTML comment (used to document the schema in-file) plus any
// surrounding whitespace, so the frontmatter block doesn't have to be byte 0.
function stripLeadingComment(raw) {
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '')
}

export function parseHelpEntry(raw, sourcePath = '<string>') {
  const match = FRONTMATTER_RE.exec(stripLeadingComment(raw))
  if (!match) throw new Error(`Help entry missing frontmatter: ${sourcePath}`)
  const [, frontmatter, body] = match

  const meta = {}
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim()) continue
    const i = line.indexOf(':')
    if (i === -1) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.id) throw new Error(`Help entry missing id: ${sourcePath}`)

  return {
    id: meta.id,
    title: meta.title || meta.id,
    summary: meta.summary || '',
    body: body.trim(),
  }
}

// Renderer for internal `[label](help:other-id)` links: turned into a plain
// anchor carrying data-help-id so components can intercept the click instead
// of navigating. External links open in a new tab.
const markdown = new Marked({
  renderer: {
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (href && href.startsWith('help:')) {
        return `<a href="#" class="help-link" data-help-id="${href.slice(5)}">${text}</a>`
      }
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
    },
  },
})

export function renderHelpMarkdown(body) {
  return markdown.parse(body)
}

let entriesCache = null

function loadEntries() {
  const modules = import.meta.glob('/src/help/*.md', { eager: true, query: '?raw', import: 'default' })
  const entries = new Map()
  for (const [path, raw] of Object.entries(modules)) {
    // One malformed file must not break every glossary term in the app: warn
    // and skip it (the term degrades to plain text) rather than throw.
    try {
      const entry = parseHelpEntry(raw, path)
      entries.set(entry.id, entry)
    } catch (err) {
      console.warn(`[help] skipping ${path}: ${err.message}`)
    }
  }
  return entries
}

export function getHelpEntry(id) {
  if (!entriesCache) entriesCache = loadEntries()
  return entriesCache.get(id) ?? null
}
