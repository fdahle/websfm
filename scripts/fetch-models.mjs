// Download the redistributable ONNX weights into public/models/ for a deploy.
// They live as assets on the `models-v1` GitHub release (the SAM2 encoder alone is
// over GitHub's 100 MB per-file limit, so they cannot be committed), and a release
// asset sends no CORS headers, so browsers cannot fetch it directly — the host has
// to serve its own copy. Run on the server before `npm run build:release`:
//
//   npm run fetch:models
//
// Files already present with the right checksum are skipped. A model whose
// license forbids redistribution (registry.js, SuperPoint) is deleted if found,
// since Vite copies public/models/ into dist/ wholesale.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MODELS, isRedistributable } from '../src/core/models/registry.js'

const RELEASE = 'https://github.com/fdahle/websfm/releases/download/models-v1/'
// Bump the release tag + these together (and MODEL_CACHE_NAME in registry.js)
// when a weight file changes under the same name.
const SHA256 = {
  'disk.onnx': 'f02f18e254bd52d978981c715a4e7961f15afaa23290379b9b357f6745df12c4',
  'lightglue.onnx': '4f44f440bc08f71afc2ba619d33154d395284001c1387b14a3b58a3224f9490e',
  'lightglue_disk.onnx': '2528772049c4d745102a389cb87ad0326d30bb3f4dbdf6520fee4fa04786e029',
  'sam2_decoder.onnx': '310fe043cc2d7d8c82a278c1075fc05547986ed80612155958b25b26c7c2e573',
  'sam2_encoder.onnx': 'bbd6003a6ab112afcd517157827eda1967b0ed9b93b493a3128f4207fc82f126',
}

const dir = new URL('../public/models/', import.meta.url)
await mkdir(dir, { recursive: true })

async function sha256Of(url) {
  try {
    return createHash('sha256').update(await readFile(url)).digest('hex')
  } catch {
    return null
  }
}

let failed = false
for (const [id, m] of Object.entries(MODELS)) {
  const target = new URL(m.file, dir)
  if (!isRedistributable(id)) {
    await rm(target, { force: true })
    continue
  }
  const want = SHA256[m.file]
  if (!want) {
    console.error(`✗ ${m.file}: no checksum recorded in fetch-models.mjs`)
    failed = true
    continue
  }
  if (await sha256Of(target) === want) {
    console.log(`✓ ${m.file} (present)`)
    continue
  }
  process.stdout.write(`↓ ${m.file} … `)
  const res = await fetch(RELEASE + m.file)
  if (!res.ok || !res.body) {
    console.log(`HTTP ${res.status}`)
    failed = true
    continue
  }
  const part = new URL(`${m.file}.part`, dir)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  if (await sha256Of(part) !== want) {
    await rm(part, { force: true })
    console.log('checksum mismatch')
    failed = true
    continue
  }
  await rename(part, target)
  console.log('ok')
}

if (failed) process.exit(1)
