import { describe, expect, it } from 'vitest'
import { useHelpHtml } from './useHelpHtml.js'

describe('useHelpHtml', () => {
  it('stays empty until loaded, then renders with the lazy help renderer', async () => {
    const { html, load } = useHelpHtml(({ renderHelpMarkdown }) => renderHelpMarkdown('Energy is $E = mc^2$.'))
    expect(html.value).toBe('')
    load()
    // The first load imports marked + KaTeX, which takes seconds in a loaded full run.
    await expect.poll(() => html.value, { timeout: 15_000 }).toContain('katex')
  })
})
