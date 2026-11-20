// The CPU half of the regression gate (`npm run gate:sfm`): every saved SfM input of the
// gate's sets (scripts/bench/gate.json ▸ dumpDir, made by `gate.mjs --dump`) replayed in
// Node, scored against the sets' reference cameras and held to the gate's baseline
// (scripts/bench/gate-baseline.json). The inputs are the exact worker payloads, so a
// change under src/core/sfm is judged without the GPU and without matching's own changes.
// About a minute a set, twice: ten minutes for the nine sets.
//
// Each input also runs a second time with its photo pairs in reverse order. Registration
// should not depend on that order; a set whose camera count changes with it is on a knife
// edge (a photo just over the correspondence floor), where any small change elsewhere can
// cost cameras: reported as a warning, with both counts.
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { beforeAll, describe, expect, it } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { reconstruct } from './sfm.js'
import { wrapPackedMatches } from './matchCodec.js'
import { decodeSfmInput } from '../../../tests/bench/sfmInputDump.js'
import { readTruth, scoreCameras } from '../../../scripts/bench/cameraScore.mjs'

const RUN = process.env.WEBSFM_SFM_GATE
const repoFile = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))

const nest = (R) =>
  Array.isArray(R[0]) ? R : [Array.from(R.slice(0, 3)), Array.from(R.slice(3, 6)), Array.from(R.slice(6, 9))]

async function replay(input) {
  const out = await reconstruct(
    {
      images: input.images,
      pairs: input.pairs,
      gcps: input.gcps,
      cameraPriors: input.cameraPriors,
      settings: input.settings ?? {},
    },
    {},
  )
  const names = new Map(input.images.map((im) => [im.uuid, im.name]))
  const model = Object.fromEntries(
    (out.cameras ?? []).map((c) => [names.get(c.uuid), { R: nest(c.R), t: Array.from(c.t) }]),
  )
  return { model, cameras: Object.keys(model).length }
}

describe.skipIf(!RUN)('SfM replay gate', () => {
  beforeAll(async () => {
    const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
    await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
  })

  // Read only when the gate is asked for: `npm test` collects this file too.
  const manifest = RUN ? JSON.parse(readFileSync(repoFile('scripts/bench/gate.json'), 'utf8')) : { sets: [] }
  const baseline = RUN ? JSON.parse(readFileSync(repoFile('scripts/bench/gate-baseline.json'), 'utf8')) : { sets: {} }
  const only = process.env.WEBSFM_SFM_GATE_ONLY ? new Set(process.env.WEBSFM_SFM_GATE_ONLY.split(',')) : null

  for (const set of manifest.sets) {
    if (only && !only.has(set.id)) continue
    const path = `${manifest.dumpDir}/${set.id}.sfminput`
    it.skipIf(!existsSync(path))(
      set.id,
      async () => {
        const load = () => {
          const input = decodeSfmInput(readFileSync(path))
          wrapPackedMatches(input.pairs)
          return input
        }
        const b = baseline.sets[set.id]
        const r = await replay(load())
        const score = set.truth ? scoreCameras(r.model, readTruth(set.truth)) : null
        const reversed = load()
        reversed.pairs = [...reversed.pairs].reverse()
        const rr = await replay(reversed)
        const line =
          `${set.id}: ${r.cameras} cameras (baseline ${b?.cameras ?? '–'})` +
          (score ? `, median ${score.median} (${b?.median ?? '–'}), ${score.off} off` : '') +
          (rr.cameras !== r.cameras ? ` — KNIFE EDGE: ${rr.cameras} with the pairs reversed` : '')
        process.stderr.write(`\n${line}\n`)
        expect(b, `${set.id} has no baseline`).toBeTruthy()
        expect(r.cameras, line).toBeGreaterThanOrEqual(b.cameras)
        if (score) {
          expect(score.off, line).toBeLessThanOrEqual(b.off ?? 0)
          expect(score.median, line).toBeLessThanOrEqual(1.25 * b.median)
        }
      },
      3600_000,
    )
  }
})
