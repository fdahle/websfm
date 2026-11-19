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
      const svg = themedSvg(href, text, title)
      if (svg) return svg
      const src = assetUrl(href) || href
      const t = title ? ` title="${escapeAttr(title)}"` : ''
      return `<img class="glossary-img" src="${src}" alt="${escapeAttr(text || '')}"${t}>`
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

// The glossary's SVG figures are drawn in one dark palette, so they read as they are
// on GitHub or opened alone. In the app they are inlined, and each palette colour
// becomes a theme variable (`--fig-*` in style.css, light and dark) with the drawn
// colour as its fallback, so a figure follows the light or dark theme. Colours
// outside the palette (a DEM's height ramp) stay as drawn.
const FIGURE_PALETTE = {
  '#1b1f27': 'bg',
  '#2a303b': 'raised',
  '#6b7280': 'line',
  '#9ca3af': 'label',
  '#c9d1d9': 'ink',
  '#5aa9e6': 'blue',
  '#e6b84f': 'yellow',
  '#ef6f6c': 'red',
  '#7ee787': 'green',
}

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

let svgMap = null
function themedSvg(href, alt, title) {
  if (!href || !/\.svg$/i.test(href)) return null
  if (!svgMap) {
    const mods = import.meta.glob('/src/glossary/assets/*.svg', { eager: true, query: '?raw', import: 'default' })
    svgMap = new Map(Object.entries(mods).map(([p, raw]) => [p.split('/').pop(), raw]))
  }
  const name = href.replace(/^\.?\/?assets\//, '')
  const raw = svgMap.get(name)
  if (raw == null) return null
  const prefix = `fig-${name.replace(/\.svg$/i, '').replace(/[^\w-]/g, '')}-`
  return (
    raw
      .replace(/<!--[\s\S]*?-->/g, '')
      // Ids are page-wide once inlined: give each figure its own.
      .replace(/\bid="([^"]+)"/g, `id="${prefix}$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
      .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`)
      // A presentation attribute takes no var(), so palette colours move to `style`.
      .replace(/<[a-zA-Z][^>]*>/g, (tag) => {
        const props = []
        const rest = tag.replace(/\s(fill|stroke|stop-color)="(#[0-9a-fA-F]{6})"/g, (m, prop, hex) => {
          const key = FIGURE_PALETTE[hex.toLowerCase()]
          if (!key) return m
          props.push(`${prop}:var(--fig-${key},${hex})`)
          return ''
        })
        if (!props.length) return rest
        return rest.replace(/\s*(\/?)>$/, ` style="${props.join(';')}"$1>`)
      })
      .replace(/^[\s\S]*?<svg\b([^>]*)>/, (m, attrs) => {
        const vb = /viewBox="[\d.\s-]*?\s([\d.]+)\s+([\d.]+)"/.exec(attrs)
        const size = vb && !/\swidth=/.test(attrs) ? ` width="${vb[1]}" height="${vb[2]}"` : ''
        const t = title ? `<title>${escapeAttr(title)}</title>` : ''
        return `<svg${attrs}${size} class="glossary-img" role="img" aria-label="${escapeAttr(alt || '')}">${t}`
      })
  )
}

// `autoLink: false` leaves glossary terms as plain text (What's New, where every
// entry would be dotted with them); explicit help:/guide: links still render.
export function renderHelpMarkdown(body, { selfId = null, autoLink = true } = {}) {
  const html = markdown.parse(body)
  return autoLink ? autoLinkHtml(html, selfId) : html
}

// Render a guide markdown fragment (intro or a param body) to auto-linked HTML.
// selfId stays null: guide docs aren't glossary entries, so nothing is suppressed.
export function renderGuide(md) {
  return renderHelpMarkdown(md || '', { selfId: null })
}
