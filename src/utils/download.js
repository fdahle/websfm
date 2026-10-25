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

// Ask where to save a file before the work that writes it, while the click that started
// it still counts as a user gesture (the save dialog needs one, and an export can run for
// minutes). Chrome and Edge then write the finished Blob straight to that file;
// Firefox and Safari have no save dialog, and a dialog refused for want of a gesture
// (the bench drives exports without a click) falls back to a download. `types` are the
// dialog's file types, [{ description, accept: { mime: ['.ext'] } }].
// → { save(blob), picked } or null when the user cancelled the dialog.
export async function pickSaveTarget(suggestedName, types) {
  let handle = null
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName, types })
    } catch (err) {
      if (err?.name === 'AbortError') return null
    }
  }
  return {
    picked: !!handle,
    async save(blob, filename = suggestedName) {
      if (!handle) return downloadBlob(filename, blob)
      // Like projectFile.js: a file the user just picked, written once and closed.
      const writable = await handle.createWritable()
      try {
        await writable.write(blob)
        await writable.close()
      } catch (err) {
        await writable.abort?.().catch(() => {})
        throw err
      }
    },
  }
}

// Convert a data: URL (e.g. an OffscreenCanvas PNG) to a Blob for download.
export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob()
}
