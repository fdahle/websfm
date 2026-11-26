// docs/BENCHMARKS.md's generated tables are the ones docs/benchmarks.json makes
// (npm run bench -- publish), and a number in the data reaches the page.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { withTables } from './bench-tables.mjs'

const root = new URL('../../../', import.meta.url)
const md = readFileSync(new URL('docs/BENCHMARKS.md', root), 'utf8')
const data = JSON.parse(readFileSync(new URL('docs/benchmarks.json', root), 'utf8'))

describe('BENCHMARKS.md tables', () => {
  it('are the ones benchmarks.json makes (run `npm run bench -- publish`, never edit them)', () => {
    expect(withTables(md, data)).toBe(md)
  })

  it('carry the data: a changed score changes its cell', () => {
    const copy = structuredClone(data)
    const job = copy.jobs.find((j) => j.id === 'eth3d-office-websfm')
    job.score.truth.median = 0.0123
    const out = withTables(md, copy)
    expect(out).not.toBe(md)
    expect(out).toContain('26/26 · 12.3')
  })

  it('bold the best of a row and report failed runs', () => {
    expect(md).toContain('**26/26 · 2.56 · 2 of 5 runs failed**')
    expect(md).toMatch(/\| South Building \| \*\*128\/128 · 0\.0050\*\* \| reference \|/)
  })

  it('refuse a marker no table answers', () => {
    expect(() => withTables('<!-- table:nope -->\n<!-- /table -->', data)).toThrow(/nope/)
  })
})
