// Source/artifact freshness gate. The build:wasm command writes this only after
// all six builds succeed; CI rejects changed Rust sources or generated artifacts
// without a corresponding rebuild. Runtime parity tests validate the codec ABI.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

async function walk(dir) {
  const paths = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['target', '.git', 'node_modules'].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) paths.push(...await walk(path))
    else paths.push(path)
  }
  return paths
}
const sources = (await walk('crates')).filter(path => /\.(rs|toml)$|Cargo\.lock$/.test(path))
sources.push('.cargo/config.toml')
const artifacts = (await walk('src/wasm')).filter(path => /\.(wasm|js|ts)$/.test(path))
const stamp = {}
for (const path of [...sources, ...artifacts].sort()) {
  stamp[path] = createHash('sha256').update(await readFile(path)).digest('hex')
}
const filename = 'src/wasm/build-stamp.json'
if (process.argv.includes('--write')) {
  await writeFile(filename, JSON.stringify(stamp, null, 2) + '\n')
  console.log(`Recorded ${sources.length} Rust inputs and ${artifacts.length} WASM artifacts`)
} else {
  const previous = JSON.parse(await readFile(filename, 'utf8'))
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(stamp)])]
    .filter(path => previous[path] !== stamp[path])
  if (changed.length) throw new Error(`WASM build is stale. Run npm run build:wasm.\n${changed.join('\n')}`)
  console.log('Rust source and committed WASM build stamp match')
}
