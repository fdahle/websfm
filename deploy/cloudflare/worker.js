// Runs only for /models/*, /ort/* and /v/* (wrangler.jsonc ▸ run_worker_first); every
// other path is a static asset that never reaches this code.
//
// /models/*, /ort/*: files too big for static assets come from R2 under their URL path;
// the rest of ort/ falls through to the assets.
//
// /v/<version>/*: the pinned copy of a release (docs/deployment.md ▸ Pinned versions),
// built with that base path and uploaded to R2 under v/<version>/ by
// `deploy-cloudflare.mjs --pinned`. Its ORT files are shared: they are named by ORT's
// version, so /v/<version>/ort/<ort version>/… reads ort/<ort version>/… . Its models
// and example datasets load from /models/ and /examples/ (built with those base URLs).
// /v/versions.json lists the versions R2 holds, newest first, for About ▸ Versions.
//
// _headers does not apply to responses built here, so its headers are set again
// (cloudflareWorker.test.js checks they match).
import { compareVersions } from '../../src/core/help/changelog.js'

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'X-Content-Type-Options': 'nosniff',
}
// The rest of _headers' block for /*, for the pages of a pinned version.
export const PAGE_HEADERS = {
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy-Report-Only':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' data: blob: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
}
const TYPES = {
  onnx: 'application/octet-stream',
  wasm: 'application/wasm',
  mjs: 'text/javascript',
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
}
const typeOf = (path) =>
  path.endsWith('/LICENSE') ? TYPES.txt : (TYPES[path.split('.').pop()] ?? 'application/octet-stream')

const VERSION_PATH = /^\/v\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(\/.*)?$/

/** The R2 key a /v/ path reads, `{ redirect }` for a version without its slash, or null. */
export function pinnedKey(path) {
  const m = VERSION_PATH.exec(path)
  if (!m) return null
  const [, version, rest] = m
  if (!rest) return { redirect: `/v/${version}/` }
  if (rest === '/') return { key: `v/${version}/index.html` }
  if (rest.startsWith('/ort/')) return { key: rest.slice(1) }
  return { key: `v/${version}${rest}` }
}

async function listVersions(bucket) {
  const versions = []
  let cursor
  do {
    const page = await bucket.list({ prefix: 'v/', delimiter: '/', cursor })
    for (const prefix of page.delimitedPrefixes ?? []) {
      const v = prefix.slice(2, -1)
      if (VERSION_PATH.test(`/v/${v}/`)) versions.push(v)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return versions.sort((a, b) => compareVersions(b, a))
}

function fromR2(object, request, path, extra = {}) {
  const headers = new Headers({ ...ISOLATION, ...extra })
  object.writeHttpMetadata(headers)
  headers.set('Content-Type', typeOf(path))
  // Content-hashed names may stay cached; the rest (unversioned model and ORT names,
  // a pinned version's index.html and sw.js) revalidate, as docs/deployment.md asks.
  headers.set('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  headers.set('ETag', object.httpEtag)
  // onlyIf matched an If-None-Match / If-Modified-Since: R2 returns no body.
  if (!('body' in object)) return new Response(null, { status: 304, headers })
  headers.set('Content-Length', String(object.size))
  return new Response(request.method === 'HEAD' ? null : object.body, { headers })
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    let path
    try {
      path = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      // A malformed escape (a lone %) is the client's error, not the worker's.
      return new Response('Bad request', { status: 400 })
    }

    if (path.startsWith('/v/')) {
      if (path === '/v/versions.json') {
        const body = JSON.stringify({ versions: await listVersions(env.LARGE_FILES) })
        return new Response(request.method === 'HEAD' ? null : body, {
          headers: { ...ISOLATION, 'Content-Type': TYPES.json, 'Cache-Control': 'public, max-age=300' },
        })
      }
      const target = pinnedKey(path)
      if (target?.redirect) return Response.redirect(new URL(target.redirect, request.url).href, 301)
      const object = target && (await env.LARGE_FILES.get(target.key, { onlyIf: request.headers }))
      if (!object) return new Response('Not found', { status: 404, headers: ISOLATION })
      return fromR2(object, request, `/${target.key}`, PAGE_HEADERS)
    }

    const object = await env.LARGE_FILES.get(path.slice(1), { onlyIf: request.headers })
    if (object === null) {
      // A missing model is a 404, not the SPA's index.html.
      if (path.startsWith('/models/')) return new Response('Not found', { status: 404 })
      const asset = await env.ASSETS.fetch(request)
      const response = new Response(asset.body, asset)
      for (const [name, value] of Object.entries(ISOLATION)) response.headers.set(name, value)
      return response
    }
    return fromR2(object, request, path)
  },
}
