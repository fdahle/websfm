// Example datasets a new user can open from the project picker ("Try an example").
//
// Like the model weights (core/models/registry.js), the images are not committed:
// the host serves them at `<BASE_URL>examples/<id>/` (or `VITE_EXAMPLE_BASE_URL`),
// with a `manifest.json` listing the files. `npm run fetch:examples` puts them in
// public/examples/ for a deploy; scripts/examples/make-example.py builds a set.
//
// Pure (no DOM, no Vue): the project lifecycle downloads through `downloadExample`
// and hands the Files to the normal image import.

// id → what the picker shows and how the project is set up. `tutorial` is the
// guide article that walks through this set (src/guide/).
export const EXAMPLES = {
  aukerman: {
    title: 'Aukerman Park',
    summary: '42 drone photos of a park in Ohio, with GPS. Builds a dense cloud, DEM and orthophoto.',
    sceneType: 'aerial',
    crs: 'EPSG:32617',
    imageCount: 42,
    approxBytes: 51_000_000,
    tutorial: 'tutorial',
    credit: 'OpenDroneMap odm_data_aukerman',
    license: 'CC0 1.0 (public domain)',
    sourceUrl: 'https://github.com/OpenDroneMap/odm_data_aukerman',
  },
}

/** Base URL the example folders are served from; always ends in a slash. */
export function exampleBaseUrl() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {}
  const base = env.VITE_EXAMPLE_BASE_URL || `${env.BASE_URL || '/'}examples/`
  return base.endsWith('/') ? base : `${base}/`
}

/**
 * The file list of a `manifest.json` ({ files: [{ name, bytes }] }), checked.
 * Throws on anything else, such as the SPA fallback page a host returns for a
 * missing file.
 */
export function parseExampleManifest(json) {
  const files = json?.files
  if (!Array.isArray(files) || !files.length) throw new Error('the manifest lists no files')
  for (const f of files) {
    // A name is a plain file name: never a path, so it cannot point outside the folder.
    if (typeof f?.name !== 'string' || !/^[\w.-]+$/.test(f.name) || f.name.startsWith('.')) {
      throw new Error(`bad file name in the manifest: ${JSON.stringify(f?.name)}`)
    }
    if (!Number.isFinite(f.bytes) || f.bytes <= 0) throw new Error(`bad size for ${f.name}`)
  }
  return files
}

/**
 * Download an example's images as Files, in manifest order.
 * `onProgress({ done, total, bytes, totalBytes })` after each file. Throws with a
 * message that names the URL when the example is not on the server.
 */
export async function downloadExample(id, { onProgress, signal, fetchFn = fetch } = {}) {
  if (!EXAMPLES[id]) throw new Error(`Unknown example: ${id}`)
  const base = `${exampleBaseUrl()}${id}/`
  const missing = (url, why) => new Error(`${url}: ${why}. The example is probably not on this server `
    + '(run npm run fetch:examples, or set VITE_EXAMPLE_BASE_URL).')

  const manifestUrl = `${base}manifest.json`
  const res = await fetchFn(manifestUrl, { signal })
  if (!res.ok) throw missing(manifestUrl, `HTTP ${res.status}`)
  let json
  try { json = await res.json() } catch { throw missing(manifestUrl, 'not JSON') }
  const files = parseExampleManifest(json)

  const totalBytes = files.reduce((s, f) => s + f.bytes, 0)
  let bytes = 0
  const out = []
  for (const f of files) {
    const url = `${base}${f.name}`
    const res = await fetchFn(url, { signal })
    if (!res.ok) throw missing(url, `HTTP ${res.status}`)
    const blob = await res.blob()
    if (/text\/html/i.test(blob.type)) throw missing(url, 'the server returned an HTML page')
    out.push(new File([blob], f.name, { type: blob.type || 'image/jpeg' }))
    bytes += f.bytes
    onProgress?.({ done: out.length, total: files.length, bytes, totalBytes })
  }
  return out
}
