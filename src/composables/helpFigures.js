// v-help-figures: on a container that shows rendered help HTML (v-html), swaps each
// glossary figure placeholder (`data-fig`, written by core/help/helpMarkdown.js before
// the figure is fetched) for the figure itself. Each figure is its own chunk, so a
// help text loads only the figures it shows.
import { loadHelpRenderer } from './useHelpHtml.js'

async function hydrate(el) {
  const pending = el.querySelectorAll('[data-fig]')
  if (!pending.length) return
  const { loadFigure } = await loadHelpRenderer()
  for (const ph of pending) {
    try {
      const html = await loadFigure(ph.dataset.fig, ph.dataset.alt || '', ph.dataset.title || null)
      if (ph.isConnected) ph.outerHTML = html
    } catch (error) {
      console.warn('[help] could not load a figure:', error)
    }
  }
}

export const vHelpFigures = { mounted: hydrate, updated: hydrate }
