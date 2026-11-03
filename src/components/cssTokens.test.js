import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// A colour token no stylesheet defines resolves to nothing: a menu panel with
// `background: var(--surface)` was see-through. Every var() must name a token that
// some stylesheet (or a style binding) defines, or carry a fallback.
const ROOT = new URL('..', import.meta.url).pathname
function files(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) files(p, out)
    else if (/\.(vue|css|js)$/.test(e.name) && !e.name.endsWith('.test.js')) out.push(p)
  }
  return out
}

describe('CSS custom properties', () => {
  it('uses only tokens that are defined, or gives a fallback', () => {
    const all = files(ROOT)
    const defined = new Set()
    for (const f of all) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1])
      for (const m of text.matchAll(/['"](--[a-z0-9-]+)['"]/g)) defined.add(m[1])
    }
    const missing = []
    for (const f of all.filter((p) => /\.(vue|css)$/.test(p))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g))
            if (!defined.has(m[1]) && !m[2]) missing.push(`${f.slice(ROOT.length)}:${i + 1} ${m[1]}`)
        })
    }
    expect(missing).toEqual([])
  })
})
