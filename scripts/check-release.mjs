import { ortVersion } from './ort-version.mjs'
import { access, readFile, stat } from 'node:fs/promises'

const dist = new URL('../dist/', import.meta.url)
const base = process.env.VITE_BASE_PATH || '/'
const externalModels = process.env.VITE_MODEL_BASE_URL

const errors = []

async function requireFile(relative, minBytes = 1) {
  const file = new URL(relative, dist)
  try {
    await access(file)
    const info = await stat(file)
    if (!info.isFile() || info.size < minBytes) {
      errors.push(`${relative} is unexpectedly small (${info.size} bytes)`)
    }
  } catch {
    errors.push(`${relative} is missing`)
  }
}

if (!base.startsWith('/') || !base.endsWith('/')) {
  errors.push('VITE_BASE_PATH must start and end with "/"')
}

await Promise.all([
  requireFile('index.html'),
  requireFile('LICENSE', 500),
  requireFile('favicon.svg', 100),
  requireFile(`ort/${ortVersion}/ort-wasm-simd-threaded.mjs`, 1_000),
  requireFile(`ort/${ortVersion}/ort-wasm-simd-threaded.wasm`, 1_000_000),
])

if (!externalModels) {
  await Promise.all([
    requireFile('models/superpoint.onnx', 1_000_000),
    requireFile('models/lightglue.onnx', 10_000_000),
    requireFile('models/sam2_encoder.onnx', 50_000_000),
    requireFile('models/sam2_decoder.onnx', 10_000_000),
  ])
}

try {
  const html = await readFile(new URL('index.html', dist), 'utf8')
  for (const fragment of [`href="${base}favicon.svg"`, `src="${base}assets/`, `href="${base}assets/`]) {
    if (!html.includes(fragment)) errors.push(`index.html does not contain ${fragment}`)
  }
} catch { /* the missing index is already reported above */ }

if (errors.length) {
  console.error('Release artifact is incomplete:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  const modelSource = externalModels ? `external models: ${externalModels}` : 'four bundled models'
  console.log(`Release artifact OK (${base}, ${modelSource})`)
}
