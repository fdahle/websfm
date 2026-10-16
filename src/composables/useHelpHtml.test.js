import { describe, expect, it } from 'vitest'
import { useHelpHtml } from './useHelpHtml.js'

describe('useHelpHtml', () => {
  it('stays empty until loaded, then renders with the lazy help renderer', async () => {
    const { html, load } = useHelpHtml(({ renderHelpMarkdown }) => renderHelpMarkdown('Energy is $E = mc^2$.'))
    expect(html.value).toBe('')
    load()
    await expect.poll(() => html.value).toContain('katex')
  })
})
