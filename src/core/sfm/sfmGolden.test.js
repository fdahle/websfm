// Golden-output gate for representation refactors of the SfM core
// (docs/planning/plan-sfm-compact-memory.md: Phases 0–3 must be bit-identical).
//
// Runs the real `reconstruct()` with the real wasm on synthetic scenes that exercise
// every stage the refactor touches — EXIF-only self-calibration with distortion folds,
// calibrated ingest undistortion + F refit, guided extension, camera priors, GCP
// anchoring, weak bridges, seed retries and a stranded secondary block — and digests
// what the worker would transfer: the packed result buffers, cameras, the summary and
// every log line, minus wall-clock times.
//
// Off by default (it takes a while). Same pattern as crates/mesh's solver weights:
//   WEBSFM_SFM_GOLDEN=write  npx vitest run src/core/sfm/sfmGolden.test.js   (old code)
//   WEBSFM_SFM_GOLDEN=check  npx vitest run src/core/sfm/sfmGolden.test.js   (new code)
// `write` also runs every scene twice and fails unless both runs are identical, which
// is the plan's precondition: the gate is only meaningful on a deterministic solver.
// WEBSFM_SFM_GOLDEN_FILE overrides the location (default: the OS temp directory).
// WEBSFM_SFM_TRACKS=map|typed runs the solver on that track store implementation.
// WEBSFM_SFM_GOLDEN_INPUTS adds real-data scenes: bench SfM input dumps (comma-separated
// paths; scripts/bench `dumpSfmInput`).

import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { goldenScenes, runGoldenScene, firstDiff } from './sfmGolden.testutil.js'

const MODE = process.env.WEBSFM_SFM_GOLDEN
const FILE = process.env.WEBSFM_SFM_GOLDEN_FILE || join(tmpdir(), 'websfm-sfm-golden.json')

describe.skipIf(!MODE)('SfM golden output (bit-identical refactor gate)', () => {
  beforeAll(async () => {
    const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
    await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
  })

  it(`${MODE} ${FILE}`, async () => {
    const got = {}
    for (const name of Object.keys(goldenScenes())) {
      got[name] = await runGoldenScene(name)
      // WEBSFM_SFM_GOLDEN_ONCE=1 skips the determinism re-run (long real-data scenes).
      if (MODE === 'write' && !process.env.WEBSFM_SFM_GOLDEN_ONCE) {
        const again = await runGoldenScene(name)
        const d = firstDiff(got[name], again)
        expect(d, `scene ${name} is not deterministic: ${d}`).toBeNull()
      }
    }
    if (MODE === 'write') {
      await writeFile(FILE, JSON.stringify(got))
      return
    }
    const want = JSON.parse(await readFile(FILE, 'utf8'))
    // Round-trip `got` through JSON so both sides have the same number encoding.
    const norm = JSON.parse(JSON.stringify(got))
    for (const name of Object.keys(goldenScenes())) {
      const d = firstDiff(want[name], norm[name], name)
      expect(d, `scene ${name} changed: ${d}`).toBeNull()
    }
  }, 4 * 3600_000) // real-data scenes (WEBSFM_SFM_GOLDEN_INPUTS) can take tens of minutes
})
