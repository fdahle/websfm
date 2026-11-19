// The glossary's SVG figures are inlined with their palette colours as theme
// variables, so they follow the light or dark theme (helpMarkdown.js ▸ themedSvg).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { renderHelpMarkdown } from './helpMarkdown.js'

const dir = new URL('../../glossary/assets/', import.meta.url)
const svgs = readdirSync(dir).filter((f) => f.endsWith('.svg'))
const PALETTE = ['#1b1f27', '#2a303b', '#6b7280', '#9ca3af', '#c9d1d9', '#5aa9e6', '#e6b84f', '#ef6f6c', '#7ee787']

describe('glossary figures', () => {
  it('there are figures to check', () => {
    expect(svgs.length).toBeGreaterThan(10)
  })

  for (const f of svgs) {
    it(`${f} is inlined with theme colours`, () => {
      const html = renderHelpMarkdown(`![Alt "quoted" & more](assets/${f})`)
      expect(html).toMatch(/<svg[^>]*class="glossary-img"[^>]*role="img"/)
      expect(html).toContain('aria-label="Alt &quot;quoted&quot; &amp; more"')
      expect(html).not.toContain('<img')
      // No palette colour is left as a fixed attribute, and each tag has one style.
      for (const hex of PALETTE) expect(html.toLowerCase()).not.toMatch(new RegExp(`(fill|stroke)="${hex}"`))
      for (const tag of html.match(/<[a-zA-Z][^>]*>/g)) expect(tag.match(/\sstyle="/g)?.length ?? 0).toBeLessThan(2)
      // A colour drawn in the palette shows through its variable, with the colour as fallback.
      const raw = readFileSync(new URL(f, dir), 'utf8')
      const used = PALETTE.filter((hex) => raw.toLowerCase().includes(`"${hex}"`))
      for (const hex of used) expect(html).toContain(`,${hex})`)
      // Ids are prefixed per figure, and what points at them follows.
      for (const [, id] of raw.matchAll(/\bid="([^"]+)"/g)) {
        expect(html).toContain(`id="fig-${f.replace('.svg', '')}-${id}"`)
        if (raw.includes(`url(#${id})`)) expect(html).toContain(`url(#fig-${f.replace('.svg', '')}-${id})`)
      }
    })
  }

  it('glossary terms are not linked inside a figure', () => {
    const html = renderHelpMarkdown('![x](assets/ransac.svg)')
    expect(html.match(/<svg[\s\S]*<\/svg>/)[0]).not.toContain('glossary-link')
  })
})
