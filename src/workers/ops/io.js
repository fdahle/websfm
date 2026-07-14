import { parseCloudFile, cloudStats } from '../../core/io/cloudImport.js'

// File-interop ops: parse a dropped/picked point-cloud or mesh file off the
// main thread (a 500 MB LAS parsed on the UI thread is the trap this avoids).
// Pure parsing lives in core/io/*; this just marshals bytes in and flat cloud
// buffers out (all in `transfer` — no clones of dense-scale data).
export function makeIoOps() {
  // args: [{ buffer: ArrayBuffer, name: string }] → { parsed, stats }
  // parsed: cloud { count, pos, col?, nrm? } | mesh { nVerts, count, pos, idx, col? }
  async function parseCloud([{ buffer, name }], { emit }) {
    const t0 = performance.now()
    const parsed = parseCloudFile(buffer, name, { onLog: (m, l, c) => emit('log', [m, l, c]) })
    const stats = cloudStats(parsed)
    emit('log', [`Parsed ${name}: ${stats.points.toLocaleString()} points`
      + `${stats.faces ? `, ${stats.faces.toLocaleString()} faces` : ''}`
      + ` in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info', 'Import'])
    const transfer = [parsed.pos.buffer]
    if (parsed.col) transfer.push(parsed.col.buffer)
    if (parsed.nrm) transfer.push(parsed.nrm.buffer)
    if (parsed.idx) transfer.push(parsed.idx.buffer)
    return { result: { parsed, stats }, transfer }
  }

  return { parseCloud }
}
