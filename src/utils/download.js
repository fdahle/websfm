// UI-layer download helpers (DOM). Pure encoders live in core/products/exporters.js; these
// wrap the bytes/text/Blob in an object URL and trigger a browser download.

// Trigger a download of `data` (a Blob, or bytes/string wrapped with `mime`).
export function downloadBlob(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // The click only schedules navigation in some engines. Revoking immediately
  // can invalidate the URL before Safari/Firefox have opened it.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Convert a data: URL (e.g. an OffscreenCanvas PNG) to a Blob for download.
export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob()
}
