// Help markdown → HTML for the glossary and the Guide: marked + KaTeX, then
// glossary auto-linking. Split from glossary.js/guide.js so marked and KaTeX
// (~300 KB minified) stay out of the entry chunk: the help dialogs import this
// module (they are lazy chunks themselves), and the always-mounted inline help
// (GlossaryTerm, FieldHelp) loads it on first hover via composables/useHelpHtml.js.
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import { autoLinkHtml } from './glossary.js'

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
      // `guide:op-id` links open (or focus) an operation tab in the Guide modal.
      // Guide docs reuse this renderer, so both schemes resolve from either place.
      if (href && href.startsWith('guide:')) {
        return `<a href="#" class="guide-link" data-guide-id="${href.slice(6)}">${text}</a>`
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
    const mods = import.meta.glob('/src/glossary/assets/*', { eager: true, query: '?url', import: 'default' })
    assetMap = new Map(Object.entries(mods).map(([p, url]) => [p.split('/').pop(), url]))
  }
  return assetMap.get(href.replace(/^\.?\/?assets\//, '')) || null
}

export function renderHelpMarkdown(body, { selfId = null } = {}) {
  const html = markdown.parse(body)
  return autoLinkHtml(html, selfId)
}

// Render a guide markdown fragment (intro or a param body) to auto-linked HTML.
// selfId stays null: guide docs aren't glossary entries, so nothing is suppressed.
export function renderGuide(md) {
  return renderHelpMarkdown(md || '', { selfId: null })
}
