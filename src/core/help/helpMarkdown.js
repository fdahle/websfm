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
    // raster images only: the SVG figures are inlined (themedSvg below)
    const mods = import.meta.glob('/src/glossary/assets/*.{png,jpg,jpeg,webp,gif}', {
      eager: true,
      query: '?url',
      import: 'default',
    })
    assetMap = new Map(Object.entries(mods).map(([p, url]) => [p.split('/').pop(), url]))
  }
  return assetMap.get(href.replace(/^\.?\/?assets\//, '')) || null
}

// The glossary's SVG figures are drawn in one dark palette, so they read as they are
// on GitHub or opened alone. In the app they are inlined, and each palette colour
// becomes a theme variable (`--fig-*` in style.css, light and dark) with the drawn
// colour as its fallback, so a figure follows the light or dark theme. Colours
// outside the palette (a DEM's height ramp) stay as drawn.
//
// Each figure is its own chunk, fetched when a help text that shows it is rendered:
// until then the renderer writes a placeholder (`data-fig`), and the container's
// v-help-figures directive (composables/helpFigures.js) swaps the figure in. Once
// fetched, a figure is inlined directly.
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

const figureLoaders = Object.fromEntries(
  Object.entries(import.meta.glob('/src/glossary/assets/*.svg', { query: '?raw', import: 'default' })).map(
    ([p, load]) => [p.split('/').pop(), load],
  ),
)
const figureRaw = new Map()
const figureName = (href) => (href && /\.svg$/i.test(href) ? href.replace(/^\.?\/?assets\//, '') : null)

/** Fetch one figure (by file name) and return it inlined and themed. */
export async function loadFigure(name, alt = '', title = null) {
  if (!figureRaw.has(name)) {
    if (!figureLoaders[name]) throw new Error(`no glossary figure ${name}`)
    figureRaw.set(name, await figureLoaders[name]())
  }
  return themeFigure(name, figureRaw.get(name), alt, title)
}

function themedSvg(href, alt, title) {
  const name = figureName(href)
  if (!name || !figureLoaders[name]) return null
  if (figureRaw.has(name)) return themeFigure(name, figureRaw.get(name), alt, title)
  const t = title ? ` data-title="${escapeAttr(title)}"` : ''
  return `<span class="glossary-img glossary-fig-pending" data-fig="${escapeAttr(name)}" data-alt="${escapeAttr(alt || '')}"${t} role="img" aria-label="${escapeAttr(alt || '')}"></span>`
}

function themeFigure(name, raw, alt, title) {
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
        if (tag.startsWith('<image')) return tag // an embedded image: its colours are data
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
