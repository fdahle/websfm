// Write the README's results table from the tables of docs/BENCHMARKS.md
// (src/core/help/readmeResults.js says which cells go where).
//
//   npm run docs:readme
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readmeWithResults } from '../src/core/help/readmeResults.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(`${root}README.md`, 'utf8')
const benchmarks = readFileSync(`${root}docs/BENCHMARKS.md`, 'utf8')
writeFileSync(`${root}README.md`, readmeWithResults(readme, benchmarks))
console.log('Wrote the results table of README.md from docs/BENCHMARKS.md')
