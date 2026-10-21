// Download the example datasets ("Try an example", src/core/examples.js) into
// public/examples/<id>/ for a deploy. Each one is a zip on the `examples-v1` GitHub
// release (built with scripts/examples/make-example.py); like the models, the host
// has to serve its own copy, since release assets send no CORS headers.
//
//   npm run fetch:examples
//
// An example whose manifest and files are already in place is skipped.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { EXAMPLES } from '../src/core/examples.js'

const RELEASE = 'https://github.com/fdahle/websfm/releases/download/examples-v1/'
// Bump the release tag + these together when an example changes.
const SHA256 = {
  aukerman: 'c48230f4dea9f51e3661d863bc6e05db2719541a785c5aef1c61f65d17e8c986',
}

const root = new URL('../public/examples/', import.meta.url)

async function present(dir) {
  try {
    const { files } = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8'))
    for (const f of files) if ((await stat(new URL(f.name, dir))).size !== f.bytes) return false
    return true
  } catch {
    return false
  }
}

let failed = false
for (const id of Object.keys(EXAMPLES)) {
  const dir = new URL(`${id}/`, root)
  if (await present(dir)) {
    console.log(`✓ ${id} (present)`)
    continue
  }
  process.stdout.write(`↓ ${id}.zip … `)
  const res = await fetch(`${RELEASE}${id}.zip`)
  if (!res.ok) {
    console.log(`HTTP ${res.status}`)
    failed = true
    continue
  }
  const zip = new Uint8Array(await res.arrayBuffer())
  if (createHash('sha256').update(zip).digest('hex') !== SHA256[id]) {
    console.log('checksum mismatch')
    failed = true
    continue
  }
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const [name, bytes] of Object.entries(unzipSync(zip))) {
    if (name.includes('/') || name.startsWith('.')) continue
    await writeFile(new URL(name, dir), bytes)
  }
  console.log((await present(dir)) ? 'ok' : 'incomplete')
}

if (failed) process.exit(1)
