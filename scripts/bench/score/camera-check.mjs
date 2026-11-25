// Camera centres of a bench run against reference cameras in COLMAP's images.txt
// (ETH3D's dslr_calibration_undistorted, COLMAP's own South Building model, …).
//
//   node scripts/bench/score/camera-check.mjs <bench result.json> <images.txt | ETH3D scene dir> [stage]
//
// Prints one JSON line: registered/total, median, p90 and max error in reference units,
// and the cameras off by more than max(5× median, 0.01) (score/camera-score.mjs does the fit).
import { readFileSync } from 'node:fs'
import { readTruth, scoreCameras } from './camera-score.mjs'

const [, , resPath, scene, stage = 'recon'] = process.argv
const res = JSON.parse(readFileSync(resPath, 'utf8'))
const model = res.stages?.[stage]?.model ?? res.stages?.[stage]?.[0]?.model
const s = scoreCameras(model, readTruth(scene))
const r = res.stages?.[stage]
console.log(
  JSON.stringify({
    scene: resPath.split('/').pop(),
    registered: `${s.registered}/${s.total}`,
    median: s.median,
    p90: s.p90,
    max: s.max,
    off: s.off,
    offNames: s.offNames.slice(0, 5),
    points: r?.points ?? r?.pointCount,
    seconds: r?.seconds,
  }),
)
