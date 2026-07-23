import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { icons } from './icons.js'

// A ribbon command naming an icon that does not exist renders an EMPTY <svg> —
// no error, no warning, just an invisible button (`icon: 'sensor'` shipped that
// way). Pin the command tables against the icon set so it can't happen silently.
const vueFiles = [
  '../components/layout/Ribbon.vue',
].map(rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))

describe('icon set', () => {
  it('defines every icon the command tables reference', () => {
    const missing = new Set()
    for (const src of vueFiles) {
      for (const [, name] of src.matchAll(/icon: *'([a-zA-Z0-9-]+)'/g)) {
        if (!(name in icons)) missing.add(name)
      }
    }
    expect([...missing]).toEqual([])
  })

  it('has a non-empty body for every entry', () => {
    for (const [name, body] of Object.entries(icons)) {
      expect(body.trim(), name).not.toBe('')
    }
  })
})
