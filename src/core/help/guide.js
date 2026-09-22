// In-app "Guide": task-oriented help for the pipeline *operations* and their
// parameters — the "how do I choose this value" companion to the concept-oriented
// glossary (src/glossary/**, core/help/glossary.js). One markdown file per operation lives
// under src/guide/, with a frontmatter block (id/title/summary), an intro, and a
// `## ` section per parameter. Each parameter section binds to a settings key via
// a `<!-- param: key  default: … -->` marker.
//
// Parsing is a pure function (no Vue/DOM) so it stays unit-testable; rendering
// reuses the glossary renderer (renderHelpMarkdown), so Guide prose auto-links
// glossary terms and both `help:`/`guide:` cross-link schemes resolve from either
// place. See src/guide/match-features.md for the schema.
import { renderHelpMarkdown } from './glossary.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
// `<!-- param: ratioThreshold  default: 0.75 -->` — key is required, default
// optional (fallback prose only; prefer passing the live value from the modal).
const PARAM_RE = /<!--\s*param:\s*([A-Za-z0-9_]+)(?:\s+default:\s*([^>]*?))?\s*-->/

// Strip a leading HTML comment (schema doc) so frontmatter needn't be byte 0.
// The schema doc itself contains a nested `<!-- param: … -->` example, so a plain
// non-greedy match would stop at that inner `-->` and leave prose before the real
// frontmatter. Anchor the end to the `-->` that is actually followed by the `---`
// frontmatter opener (the lookahead makes the non-greedy match extend past inner
// `-->`s until the frontmatter follows).
function stripLeadingComment(raw) {
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*(?=---)/, '')
}

export function parseGuideDoc(raw, sourcePath = '<string>') {
  const match = FRONTMATTER_RE.exec(stripLeadingComment(raw))
  if (!match) throw new Error(`Guide doc missing frontmatter: ${sourcePath}`)
  const [, frontmatter, body] = match

  const meta = {}
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim()) continue
    const i = line.indexOf(':')
    if (i === -1) continue
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.id) throw new Error(`Guide doc missing id: ${sourcePath}`)

  // Split the body on `## ` headings: text before the first heading is the
  // operation intro; each subsequent chunk documents one parameter.
  const chunks = body.split(/^## /m)
  const intro = chunks.shift().trim()
  const params = new Map() // key -> { key, label, defaultText, body }
  const order = []         // param keys in document order
  for (const chunk of chunks) {
    const nl = chunk.indexOf('\n')
    const label = (nl === -1 ? chunk : chunk.slice(0, nl)).trim()
    let secBody = nl === -1 ? '' : chunk.slice(nl + 1)
    const pm = PARAM_RE.exec(secBody)
    // Fall back to a slug of the heading if no explicit param marker is present.
    const key = pm?.[1] ?? label.toLowerCase().replace(/\s+/g, '-')
    secBody = secBody.replace(PARAM_RE, '').trim()
    const entry = { key, label, defaultText: pm?.[2]?.trim() || null, body: secBody }
    params.set(key, entry)
    order.push(key)
  }

  return {
    id: meta.id,
    title: meta.title || meta.id,
    summary: meta.summary || '',
    category: meta.category || 'More',
    sortOrder: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 999,
    intro,
    params,
    order,
  }
}

// ── Doc loading + lookup ────────────────────────────────────────────────────────
let docsCache = null

function loadDocs() {
  if (docsCache) return docsCache
  const modules = import.meta.glob('/src/guide/**/*.md', { eager: true, query: '?raw', import: 'default' })
  const docs = new Map()
  for (const [path, raw] of Object.entries(modules)) {
    // One malformed file must not break the whole Guide: warn and skip it.
    try {
      const doc = parseGuideDoc(raw, path)
      docs.set(doc.id, doc)
    } catch (err) {
      console.warn(`[guide] skipping ${path}: ${err.message}`)
    }
  }
  docsCache = docs
  return docs
}

export function getGuideDoc(id) {
  return loadDocs().get(id) ?? null
}

export function getParam(opId, key) {
  return loadDocs().get(opId)?.params.get(key) ?? null
}

export function getAllGuideDocs() {
  return [...loadDocs().values()].sort((a, b) =>
    a.sortOrder - b.sortOrder || a.title.localeCompare(b.title),
  )
}

// Render a guide markdown fragment (intro or a param body) to auto-linked HTML.
// selfId stays null: guide docs aren't glossary entries, so nothing is suppressed.
export function renderGuide(md) {
  return renderHelpMarkdown(md || '', { selfId: null })
}

// Case-insensitive search over operation title/summary/intro and param labels.
export function searchGuide(query) {
  const q = query.trim().toLowerCase()
  if (!q) return getAllGuideDocs()
  const scored = []
  for (const d of loadDocs().values()) {
    const inTitle = d.title.toLowerCase().includes(q)
    const inBody = d.summary.toLowerCase().includes(q) || d.intro.toLowerCase().includes(q) ||
      [...d.params.values()].some(p => p.label.toLowerCase().includes(q) || p.body.toLowerCase().includes(q))
    if (inTitle) scored.push({ d, rank: 0 })
    else if (inBody) scored.push({ d, rank: 1 })
  }
  return scored.sort((a, b) => a.rank - b.rank || a.d.title.localeCompare(b.d.title)).map(s => s.d)
}
