// A synthetic SfM run inside a worker (tests/browser/ba-scale.spec.js): the bundle
// adjustment's threaded build only starts in a worker of a cross-origin isolated page.
import { aerialBlock } from '/src/core/sfm/syntheticScene.testutil.js'
import { reconstruct } from '/src/core/sfm/sfm.js'
import { SFM_TUNING } from '/src/core/tuning.js'

self.onmessage = async ({ data: { seed, side, threads } }) => {
  try {
    SFM_TUNING.baSolver.threads = threads
    const sc = aerialBlock({ seed, rows: side, cols: side, nPoints: 40 * side * side, calibrated: true })
    const t0 = performance.now()
    const out = await reconstruct(
      { images: sc.images, pairs: sc.pairs, settings: { secondaryModels: false } },
      { onLog: () => {} },
    )
    const ms = performance.now() - t0
    // Bit digest of the final poses (FNV-1a over the Float64 bytes, by uuid).
    let h = 0x811c9dc5
    const buf = new Float64Array(1),
      bytes = new Uint8Array(buf.buffer)
    for (const c of [...out.cameras].sort((a, b) => (a.uuid < b.uuid ? -1 : 1))) {
      for (const v of [...c.R.flat(), ...c.t]) {
        buf[0] = v
        for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0
      }
    }
    postMessage({
      ms,
      cameras: out.cameras.length,
      digest: h.toString(16),
      timings: out.summary?.timings,
      baSolver: out.summary?.baSolver,
      isolated: self.crossOriginIsolated,
    })
  } catch (err) {
    postMessage({ error: err?.message ?? String(err) })
  }
}
