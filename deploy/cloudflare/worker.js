// Runs only for /models/* and /ort/* (wrangler.jsonc ▸ run_worker_first); every other
// path is a static asset that never reaches this code. Files too big for static
// assets come from R2 under their URL path; the rest of ort/ falls through to the
// assets. _headers does not apply to responses built here, so the cross-origin
// isolation headers are set again.

const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}
const TYPES = { onnx: 'application/octet-stream', wasm: 'application/wasm', mjs: 'text/javascript' }

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    const path = decodeURIComponent(new URL(request.url).pathname)
    const object = await env.LARGE_FILES.get(path.slice(1), { onlyIf: request.headers })

    if (object === null) {
      // A missing model is a 404, not the SPA's index.html.
      if (path.startsWith('/models/')) return new Response('Not found', { status: 404 })
      const asset = await env.ASSETS.fetch(request)
      const response = new Response(asset.body, asset)
      for (const [name, value] of Object.entries(ISOLATION)) response.headers.set(name, value)
      return response
    }

    const headers = new Headers(ISOLATION)
    object.writeHttpMetadata(headers)
    headers.set('Content-Type', TYPES[path.split('.').pop()] ?? 'application/octet-stream')
    // Unversioned names: revalidate, as docs/deployment.md asks for .onnx and ORT files.
    headers.set('Cache-Control', 'no-cache')
    headers.set('ETag', object.httpEtag)
    // onlyIf matched an If-None-Match / If-Modified-Since: R2 returns no body.
    if (!('body' in object)) return new Response(null, { status: 304, headers })
    headers.set('Content-Length', String(object.size))
    return new Response(request.method === 'HEAD' ? null : object.body, { headers })
  },
}
