import { attributeBuffers } from '../../core/io/cloudAttributes.js'
import { cropCloud, filterCloud, mergeClouds, cloudCount } from '../../core/products/cloudEdit.js'

// Cloud-editing ops (crop / filter / merge). Pure math lives in
// core/products/cloudEdit.js; this file only marshals buffers. No injected worker
// helpers (nothing here rasterises or touches wasm).
//
// The store TRANSFERS the source buffers in (a 25 M-point clone would cost ~300 MB),
// so — exactly like `meshify` — every input cloud is round-tripped home under
// `home[]`, keyed by the cloud id, and the store re-attaches them. Editing is
// non-destructive: the source cloud must still be usable afterwards.
export function makeCloudOps() {
  // Rebuild the home payload + transfer list for the inputs. Called once, at the
  // end, so a throw mid-edit leaves the buffers un-transferred (the call rejects and
  // the store's catch leaves its own arrays untouched).
  function homeward(clouds, transfer) {
    return clouds.map((c) => {
      if (c.pos?.buffer) transfer.push(c.pos.buffer)
      if (c.col?.buffer) transfer.push(c.col.buffer)
      if (c.nrm?.buffer) transfer.push(c.nrm.buffer)
      return { id: c.id, pos: c.pos, col: c.col || null, nrm: c.nrm || null }
    })
  }

  // Push the edited cloud's own buffers onto the transfer list.
  function outward(out, transfer) {
    if (out.pos?.buffer) transfer.push(out.pos.buffer)
    if (out.col?.buffer) transfer.push(out.col.buffer)
    if (out.nrm?.buffer) transfer.push(out.nrm.buffer)
    transfer.push(...attributeBuffers(out))
  }

  // input: { mode: 'crop'|'filter'|'merge', clouds: [{ id, count, pos, col, nrm }],
  //          settings }. Resolves to { cloud, error, home }.
  //
  // This op NEVER throws. The source buffers are already detached on the caller's
  // side by the time we run, so a thrown error would reject the call with no way to
  // carry a transfer list — destroying the user's cloud. Failures come back as
  // `{ cloud: null, error }` alongside the round-tripped `home` buffers, and the
  // store raises them.
  async function editCloud([input], { emit }) {
    const { mode, clouds = [], settings = {} } = input
    const log = (m, l, c) => emit('log', [m, l, c])
    const transfer = []
    let out = null, error = null
    try {
      if (!clouds.length) throw new Error('no source cloud')
      const t0 = performance.now()
      emit('progress', [0, 1, mode === 'merge' ? 'Merging…' : `${mode === 'crop' ? 'Cropping' : 'Filtering'}…`])

      if (mode === 'crop') out = cropCloud(clouds[0], settings, log)
      else if (mode === 'filter') out = filterCloud(clouds[0], settings, log)
      else if (mode === 'merge') out = mergeClouds(clouds, settings, log)
      else throw new Error(`unknown mode "${mode}"`)

      const before = clouds.reduce((s, c) => s + cloudCount(c), 0)
      log(`${mode[0].toUpperCase()}${mode.slice(1)}: ${cloudCount(out).toLocaleString()} points `
        + `from ${before.toLocaleString()} in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      cloudCount(out) ? 'success' : 'warn', 'Products')
      emit('progress', [1, 1, 'Done'])
      outward(out, transfer)
    } catch (err) {
      out = null
      error = err?.message ?? String(err)
    }
    const home = homeward(clouds, transfer)
    return { result: { cloud: out, error, home }, transfer }
  }

  return { editCloud }
}
