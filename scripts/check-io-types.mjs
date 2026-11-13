// Type-check the listed src/core/io parsers (tsconfig.io.json `files`) and fail on an
// error in one of them. tsc also checks every file they import; those errors are not
// this check's business (most of src/core is not typed yet), so they are dropped.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'

const config = JSON.parse(
  readFileSync(new URL('../tsconfig.io.json', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
)
const listed = new Set(config.files)
let out = ''
try {
  execFileSync('npx', ['tsc', '--noEmit', '-p', 'tsconfig.io.json'], { encoding: 'utf8', stdio: 'pipe' })
} catch (err) {
  out = String(err.stdout ?? '')
}
const errors = out.split('\n').filter((line) => {
  const m = /^(.+?)\(\d+,\d+\): error TS/.exec(line)
  // A listed file's error, or one with no file at all (a bad config, a missing file).
  return m ? listed.has(m[1]) : /^error TS/.test(line)
})
if (errors.length) {
  console.error(errors.join('\n'))
  console.error(`\n${errors.length} type error(s) in the checked io parsers (tsconfig.io.json).`)
  process.exit(1)
}
console.log(`io parsers type-check clean (${listed.size} files)`)
