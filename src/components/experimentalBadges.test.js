import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EXPERIMENTAL, experimentalTitle } from '../core/help/experimental.js'

// Every experimental feature shows its badge somewhere, and every badge names a feature
// in core/help/experimental.js: when a feature's checks pass, its entry and its badges
// go together.
const ROOT = new URL('.', import.meta.url).pathname
function vueFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) vueFiles(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const used = new Map()
for (const f of vueFiles(ROOT)) {
  const text = readFileSync(f, 'utf8')
  const ids = [
    ...[...text.matchAll(/<ExperimentalBadge[^>]*\sid="([\w-]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/\bexperimental="([\w-]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/:experimental="[^"]*'([\w-]+)'[^"]*"/g)].map((m) => m[1]),
  ]
  for (const id of ids) used.set(id, [...(used.get(id) ?? []), f.slice(ROOT.length)])
}

describe('Experimental badges', () => {
  it('every entry is shown by a badge', () => {
    expect(Object.keys(EXPERIMENTAL).filter((id) => !used.has(id))).toEqual([])
  })
  it('every badge names an entry', () => {
    expect([...used.keys()].filter((id) => !EXPERIMENTAL[id])).toEqual([])
  })
  it('the hover text says what is still open and what to do', () => {
    for (const id of Object.keys(EXPERIMENTAL)) {
      const t = experimentalTitle(id)
      expect(t).toMatch(/^Experimental: /)
      expect(t).toContain(EXPERIMENTAL[id].unchecked)
      expect(t).toMatch(/Compare its results with a reference/)
    }
    expect(experimentalTitle('nope')).toBeNull()
  })
})
