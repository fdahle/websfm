export function readSfmZip(file, { wanted, signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zip.worker.js', import.meta.url), { type: 'module' })
    const finish = (error, result) => {
      worker.terminate()
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(new DOMException('Import cancelled', 'AbortError'))
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result)
    worker.onerror = event => finish(new Error(event.message || 'ZIP worker failed'))
    worker.postMessage({ file, wanted })
  })
}
