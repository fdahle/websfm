// Score an outside point cloud (a LAS file in the LiDAR's CRS: Metashape's or ODM's
// dense cloud, a dataset's own MVS cloud) against a bench LiDAR reference, with the
// same check the bench runs on WebSfM's clouds (lidar.mjs lidarCheckGrid): a fitted
// horizontal shift and height offset, then the tilt, the dome and the scatter on flat
// LiDAR cells.
//
//   node scripts/bench/lidar-score.mjs <cloud.las> <bench config.json> [maxPoints=1000000]
//
// The config's `reference.lidar` names the LiDAR (dir, crs, cell, flatRangeM). The LAS
// file is read uncompressed (no LAZ) and strided down to maxPoints. Prints one JSON line.
import { open, readFile } from 'node:fs/promises'
import { readLasHeader } from '../../src/core/io/las.js'
import { loadLidarGrid, lidarCheckGrid } from './lidar.mjs'

const [, , lasPath, cfgPath, maxArg] = process.argv
if (!lasPath || !cfgPath) {
  console.error('usage: node scripts/bench/lidar-score.mjs <cloud.las> <bench config.json> [maxPoints]')
  process.exit(2)
}
const maxPoints = Number(maxArg ?? 1_000_000)
const cfg = JSON.parse(await readFile(cfgPath, 'utf8'))
const lidarCfg = cfg.reference?.lidar
if (!lidarCfg) throw new Error(`${cfgPath}: no reference.lidar`)

const fh = await open(lasPath, 'r')
try {
  const head = Buffer.alloc(64 * 1024)
  await fh.read(head, 0, head.length, 0)
  const h = readLasHeader(new Uint8Array(head.buffer, head.byteOffset, head.length))
  if (h.isLaz) throw new Error('LAZ is not supported here: decompress it first (e.g. pdal translate)')
  const n = Number(h.count)
  const stride = Math.max(1, Math.floor(n / maxPoints))
  // Read in blocks of records and keep every stride-th: X, Y, Z are the first 12 bytes
  // of every record format.
  const pts = []
  const per = 65536
  const buf = Buffer.alloc(per * h.recordLength)
  for (let first = 0; first < n; first += per) {
    const m = Math.min(per, n - first)
    await fh.read(buf, 0, m * h.recordLength, h.offsetToPoints + first * h.recordLength)
    for (let i = (stride - (first % stride || stride)) % stride; i < m; i += stride) {
      const o = i * h.recordLength
      pts.push([
        buf.readInt32LE(o) * h.scale[0] + h.offset[0],
        buf.readInt32LE(o + 4) * h.scale[1] + h.offset[1],
        buf.readInt32LE(o + 8) * h.scale[2] + h.offset[2],
      ])
    }
  }
  const grid = await loadLidarGrid(lidarCfg, (msg) => console.error(`== ${msg}`))
  const r = lidarCheckGrid(pts, grid, { flatRangeM: lidarCfg.flatRangeM ?? 0.15 })
  console.log(JSON.stringify({ file: lasPath, lasPoints: n, stride, ...r }))
} finally {
  await fh.close()
}
