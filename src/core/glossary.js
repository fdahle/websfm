// In-app glossary/help content: markdown files under src/help/, each with a
// small frontmatter block (id/title/summary/aliases) and a markdown body.
// Parsing is a pure function (no Vue/DOM) so it stays unit-testable and the
// loader can run in the worker or main thread alike; rendering (markdown +
// KaTeX + auto-linking) only ever runs on the main thread in the glossary
// modal. See src/help/reprojection-error.md for the schema.
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'

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

  // aliases: comma-separated extra phrases that auto-link to this entry (the
  // title is always an alias). Lower-cased + de-duped for matching.
  const aliases = new Set([meta.title || meta.id])
  if (meta.aliases) for (const a of meta.aliases.split(',')) { const t = a.trim(); if (t) aliases.add(t) }

  return {
    id: meta.id,
    title: meta.title || meta.id,
    summary: meta.summary || '',
    aliases: [...aliases],
    body: body.trim(),
  }
}

// Markdown renderer. Internal `[label](help:other-id)` links become plain
// anchors carrying data-help-id so the modal can intercept the click (open a
// tab) instead of navigating; external links open in a new tab. Images resolve
// against the bundled asset map (see assetUrl). KaTeX handles `$…$`/`$$…$$`.
const markdown = new Marked({
  renderer: {
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (href && href.startsWith('help:')) {
        return `<a href="#" class="glossary-link" data-help-id="${href.slice(5)}">${text}</a>`
      }
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
    },
    image({ href, title, text }) {
      const src = assetUrl(href) || href
      const t = title ? ` title="${title}"` : ''
      return `<img class="glossary-img" src="${src}" alt="${text || ''}"${t}>`
    },
  },
})
markdown.use(markedKatex({ throwOnError: false, nonStandard: true }))

// Images referenced as ![alt](assets/foo.png) resolve to hashed build URLs.
let assetMap = null
function assetUrl(href) {
  if (!href || /^(https?:)?\/\//.test(href) || href.startsWith('data:')) return null
  if (!assetMap) {
    const mods = import.meta.glob('/src/help/assets/*', { eager: true, query: '?url', import: 'default' })
    assetMap = new Map(Object.entries(mods).map(([p, url]) => [p.split('/').pop(), url]))
  }
  return assetMap.get(href.replace(/^\.?\/?assets\//, '')) || null
}

export function renderHelpMarkdown(body, { selfId = null } = {}) {
  const html = markdown.parse(body)
  return autoLinkHtml(html, selfId)
}

// ── Auto-linking ──────────────────────────────────────────────────────────────
// Wrap the first occurrence of each known alias in the rendered HTML with a
// glossary link, so cross-references between entries appear automatically. We
// walk the HTML as an alternating tag/text stream and suppress linking inside
// anchors, code, KaTeX output, and any element carrying a `no-help` class — the
// authoring opt-out for a specific occurrence.
const SUPPRESS_TAGS = new Set(['a', 'code', 'pre', 'script', 'style', 'button'])
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr'])

function buildAliasIndex(entries, selfId) {
  // Longest aliases first so "bundle adjustment" wins over "adjustment".
  const list = []
  for (const e of entries.values()) {
    if (e.id === selfId) continue
    for (const alias of e.aliases) list.push({ alias, id: e.id, len: alias.length })
  }
  return list.sort((a, b) => b.len - a.len)
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function autoLinkHtml(html, selfId = null) {
  const entries = loadEntries()
  const index = buildAliasIndex(entries, selfId)
  if (!index.length) return html
  const used = new Set()

  // Split on tags; even indices are text, odd indices are the tag strings.
  const parts = html.split(/(<[^>]+>)/)
  const stack = [] // open elements: { name, suppress }
  let suppressDepth = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i % 2 === 1) {
      // A tag. Maintain the suppression stack.
      const m = /^<\s*(\/?)\s*([a-zA-Z0-9-]+)/.exec(part)
      if (!m) continue
      const [, closing, rawName] = m
      const name = rawName.toLowerCase()
      const selfClosing = /\/>\s*$/.test(part) || VOID_TAGS.has(name)
      if (closing) {
        const idx = stack.map(f => f.name).lastIndexOf(name)
        if (idx !== -1) {
          if (stack[idx].suppress) suppressDepth--
          stack.splice(idx, 1)
        }
      } else if (!selfClosing) {
        const suppress = SUPPRESS_TAGS.has(name) ||
          /class\s*=\s*"[^"]*\b(no-help|katex)\b[^"]*"/.test(part)
        if (suppress) suppressDepth++
        stack.push({ name, suppress })
      }
      continue
    }
    if (!part || suppressDepth > 0) continue
    parts[i] = linkText(part, index, used)
  }
  return parts.join('')
}

function linkText(text, index, used) {
  let out = text
  for (const { alias, id } of index) {
    if (used.has(id)) continue
    // Whole-word, case-insensitive, first hit only.
    const re = new RegExp(`\\b(${escapeRe(alias)})\\b`, 'i')
    if (!re.test(out)) continue
    used.add(id)
    out = out.replace(re, `<a href="#" class="glossary-link" data-help-id="${id}">$1</a>`)
  }
  return out
}

// ── Entry loading + lookup ─────────────────────────────────────────────────────
let entriesCache = null

function loadEntries() {
  if (entriesCache) return entriesCache
  const modules = import.meta.glob('/src/help/*.md', { eager: true, query: '?raw', import: 'default' })
  const entries = new Map()
  for (const [path, raw] of Object.entries(modules)) {
    // One malformed file must not break every glossary term in the app: warn
    // and skip it (the term degrades to plain text) rather than throw.
    try {
      const entry = parseHelpEntry(raw, path)
      entries.set(entry.id, entry)
    } catch (err) {
      console.warn(`[glossary] skipping ${path}: ${err.message}`)
    }
  }
  entriesCache = entries
  return entries
}

export function getHelpEntry(id) {
  return loadEntries().get(id) ?? null
}

export function getAllHelpEntries() {
  return [...loadEntries().values()].sort((a, b) => a.title.localeCompare(b.title))
}

// Case-insensitive search over title/summary/aliases/body. Returns entries
// ranked title-match first, then body, so the home tab's search box is useful.
export function searchGlossary(query) {
  const q = query.trim().toLowerCase()
  if (!q) return getAllHelpEntries()
  const scored = []
  for (const e of loadEntries().values()) {
    const inTitle = e.title.toLowerCase().includes(q) ||
      e.aliases.some(a => a.toLowerCase().includes(q))
    const inBody = e.summary.toLowerCase().includes(q) || e.body.toLowerCase().includes(q)
    if (inTitle) scored.push({ e, rank: 0 })
    else if (inBody) scored.push({ e, rank: 1 })
  }
  return scored.sort((a, b) => a.rank - b.rank || a.e.title.localeCompare(b.e.title)).map(s => s.e)
}
