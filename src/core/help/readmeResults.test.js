import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { readmeWithResults, readmeResultsTable, markdownTables, cellReader } from './readmeResults.js'

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

describe('README results table', () => {
  it('is the one docs/BENCHMARKS.md makes (run `npm run docs:readme` after changing BENCHMARKS)', () => {
    const readme = read('README.md')
    expect(readme).toBe(readmeWithResults(readme, read('docs/BENCHMARKS.md')))
  })

  it('takes its numbers from the BENCHMARKS cells: a changed cell changes the README', () => {
    const md = read('docs/BENCHMARKS.md')
    // PUTI's checkpoints with RTK, whatever the published run measured ("3.07 / 7.93 (15)").
    const was = cellReader(md)('Drone blocks, RTK positions in the solve', ['GeoScan PUTI', 'WebSfM'], 'checkpoints')
    expect(md.split(`| ${was} |`)).toHaveLength(2)
    const before = readmeResultsTable(md)
    const after = readmeResultsTable(md.replace(`| ${was} |`, '| 9.87 / 6.54 (15) |'))
    expect(before).toContain(`Checkpoints ${was.replace(/ \(\d+\)$/, '')} cm`)
    expect(after).toContain('Checkpoints 9.87 / 6.54 cm')
  })

  it('names the cell it cannot find', () => {
    const md = read('docs/BENCHMARKS.md').replace('### Drone blocks, RTK positions in the solve', '### RTK blocks')
    expect(() => readmeResultsTable(md)).toThrow(/Drone blocks, RTK positions in the solve/)
  })
})

describe('markdownTables', () => {
  const md = [
    '### Blocks',
    '',
    '| block | run | score |',
    '| --- | --- | --- |',
    '| quarry | WebSfM | **4.6** / 21.6 |',
    '| | Metashape | 3.8 |',
  ].join('\n')

  it('reads a table under its heading, repeating a block for its second row, without bold', () => {
    const [t] = markdownTables(md).get('Blocks')
    expect(t.header).toEqual(['block', 'run', 'score'])
    expect(t.rows).toEqual([
      ['quarry', 'WebSfM', '4.6 / 21.6'],
      ['quarry', 'Metashape', '3.8'],
    ])
    expect(cellReader(md)('Blocks', ['quarry', 'Metashape'], 'score')).toBe('3.8')
  })
})
