import { computed, shallowRef } from 'vue'

// Help HTML for the always-mounted inline help (GlossaryTerm, FieldHelp) without
// putting marked + KaTeX in the entry chunk: the renderer module
// (core/help/helpMarkdown.js) is fetched on the first `load()`, typically the
// first hover, and shared by every caller after that.

let rendererPromise = null

export function loadHelpRenderer() {
  rendererPromise ??= import('../core/help/helpMarkdown.js').catch((error) => {
    rendererPromise = null // retry on the next hover rather than stay broken
    throw error
  })
  return rendererPromise
}

/**
 * `html` is `render(renderer)` once the renderer is loaded, '' before. Call
 * `load()` when the HTML is about to be shown.
 */
export function useHelpHtml(render) {
  const renderer = shallowRef(null)
  const html = computed(() => (renderer.value ? render(renderer.value) : ''))
  function load() {
    if (renderer.value) return
    loadHelpRenderer().then(
      (module) => {
        renderer.value = module
      },
      (error) => {
        console.warn('[help] could not load the help renderer:', error)
      },
    )
  }
  return { html, load }
}
