// Pre-flight checks (usability track U5) — the cheap "can this even run, and what
// will bite me?" pass shown before a pipeline stage starts.
//
// Pure: a plain project-state snapshot in (each field nullable, assembled by the
// caller the same way `core/eval/health.js` takes a snapshot), a flat ordered list
// of checks out. No Vue/Pinia/DOM. A `block`-level check disables Run; a `warn` is
// advisory. Every check carries a `fix` — what the user should do about it — so the
// UI never has to invent guidance.
//
// Levels:
//   'block' → a hard prerequisite is missing; the stage cannot run.
//   'warn'  → the stage can run but the result is likely degraded / risky.

import { formatBytes } from './dense/memBudget.js'

/**
 * @typedef {object} PreflightState
 * @property {number} [nImages]                total source images
 * @property {number} [detectedImageCount]     images with keypoints computed
 * @property {number} [verifiedPairCount]      enabled + verified match pairs
 * @property {number} [totalPairCount]         all match pairs (to tell "none" from "all disabled")
 * @property {Array<{label?: string}>} [sensorsMissingFocal]         sensors with no focal length
 * @property {Array<{label?: string}>} [filmSensorsMissingFiducials] film sensors lacking calibrated fiducials
 * @property {{ projectedBytes: number, budgetBytes: number } | null} [dense] dense-run memory projection
 * @property {{ requested: boolean, available: boolean } | null} [gpu]        GPU backend request vs availability
 */

/**
 * @typedef {object} PreflightCheck
 * @property {'block'|'warn'} level
 * @property {string} code   stable machine id
 * @property {string} msg    what is wrong
 * @property {string} fix    what to do about it
 */

const labelList = (items, max = 3) => {
  const names = (items || []).map((s) => s?.label).filter(Boolean)
  if (!names.length) return ''
  const shown = names.slice(0, max).join(', ')
  return names.length > max ? `${shown}, …` : shown
}

/**
 * Run the pre-flight checks over a project-state snapshot.
 * @param {PreflightState} [state]
 * @returns {PreflightCheck[]} ordered blocks-first, then warnings.
 */
export function preflight(state = {}) {
  const s = state
  const checks = []
  const add = (level, code, msg, fix) => checks.push({ level, code, msg, fix })

  // ── Blocks (hard prerequisites) ────────────────────────────────────────────
  if ((s.nImages ?? 0) < 2) {
    add('block', 'too-few-images',
      `Only ${s.nImages ?? 0} image(s) loaded.`,
      'Add at least two overlapping images before running the pipeline.')
    // With no images nothing else is meaningful — but keep going so the caller
    // still sees any sensor warnings it wants to surface; the block alone gates Run.
  }

  if ((s.nImages ?? 0) >= 2 && s.detectedImageCount != null && s.detectedImageCount === 0) {
    add('block', 'no-keypoints',
      'No image has keypoints yet.',
      'Run Detect Features first — matching and reconstruction have nothing to work from otherwise.')
  }

  // Only a real blocker once detection has produced something to match.
  if ((s.detectedImageCount ?? 0) > 0 && s.verifiedPairCount != null && s.verifiedPairCount === 0) {
    if ((s.totalPairCount ?? 0) > 0) {
      add('block', 'all-pairs-disabled',
        `All ${s.totalPairCount} match pair(s) are disabled or rejected.`,
        'Re-enable pairs in the match list, or lower the matching gates (minMatches / inlier ratio) and re-run matching.')
    } else {
      add('block', 'no-matches',
        'No verified match pairs.',
        'Run Match Features; if it finds nothing, lower minMatches or raise detection resolution/keypoints so images share features.')
    }
  }

  // ── Warnings (degraded but runnable) ───────────────────────────────────────
  const noFocal = labelList(s.sensorsMissingFocal)
  if (noFocal) {
    add('warn', 'missing-focal',
      `No focal length on sensor(s): ${noFocal}.`,
      'Enter the focal length or film/sensor width; self-calibration will estimate it, but a good starting value gives a cleaner solve.')
  }

  const noFid = labelList(s.filmSensorsMissingFiducials)
  if (noFid) {
    add('warn', 'film-no-fiducials',
      `Film sensor(s) without calibrated fiducials: ${noFid}.`,
      'Detect and calibrate fiducial marks so interior orientation is removed at ingest — otherwise the scan geometry biases the reconstruction.')
  }

  if (s.dense && s.dense.projectedBytes > s.dense.budgetBytes) {
    add('warn', 'dense-over-budget',
      `Dense run is projected to need ${formatBytes(s.dense.projectedBytes)}, over the ${formatBytes(s.dense.budgetBytes)} budget.`,
      'Lower the depth-map quality or the number of source views, or process fewer images at once, to avoid an out-of-memory tab crash.')
  }

  if (s.gpu && s.gpu.requested && !s.gpu.available) {
    add('warn', 'gpu-unavailable',
      'GPU acceleration is requested but no WebGPU adapter is available.',
      'The run will fall back to the (slower) CPU backend. Use a Chromium browser with WebGPU enabled for the GPU path.')
  }

  // Blocks first, warnings after; stable within each level (insertion order).
  const rank = { block: 0, warn: 1 }
  checks.sort((a, b) => rank[a.level] - rank[b.level])
  return checks
}

/** True when any check blocks the run (the UI disables Run on this). */
export function hasBlockers(checks) {
  return (checks || []).some((c) => c.level === 'block')
}
