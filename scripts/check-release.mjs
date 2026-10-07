import { ortVersion } from './ort-version.mjs'
import { access, readFile, stat } from 'node:fs/promises'
import { MODELS, isRedistributable } from '../src/core/models/registry.js'

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

// Bundled models: every redistributable one must be present (at least half its
// registered size, so a truncated or HTML-fallback file fails here). A model whose
// license forbids redistribution (registry.js, SuperPoint) must NOT be in the
// artifact — Vite copies public/models/ wholesale, so a developer's local copy
// would otherwise ship silently.
const shippable = Object.entries(MODELS).filter(([id]) => isRedistributable(id))
const restricted = Object.entries(MODELS).filter(([id]) => !isRedistributable(id))
if (!externalModels) {
  await Promise.all(shippable.map(([, m]) => requireFile(`models/${m.file}`, Math.round(m.approxBytes / 2))))
}
for (const [, m] of restricted) {
  try {
    await access(new URL(`models/${m.file}`, dist))
    errors.push(`models/${m.file} must not be shipped (${m.license}); delete it from dist/ (and public/models/)`)
  } catch { /* absent, as required */ }
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
  const modelSource = externalModels ? `external models: ${externalModels}` : `${shippable.length} bundled models`
  console.log(`Release artifact OK (${base}, ${modelSource})`)
}
