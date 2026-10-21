// Mill19 (Mega-NeRF's Building / Rubble drone sets) → bench reference data.
//
//   node scripts/bench/mill19-prep.mjs <mill19 dir> [building|rubble …]
//
// The JPEGs carry no EXIF (no focal length, no GPS); every image's intrinsics and its
// PixSFM-refined pose live in <set>-pixsfm/train/metadata/<n>.pt (a PyTorch zip: the
// pickle names the tensors, archive/data/N holds them raw — read here without torch).
// Positions are normalised: metres = c2w translation · pose_scale_factor + origin_drb
// (coordinates.pt), in a down/right/back frame. Writes, per set:
//   <set>-cameras.txt   name lat lon h — the reference centres as WGS84 around an
//                       arbitrary origin (east = right, north = −back, up = −down), the
//                       format the bench's `reference.cameras` reads; drone sets have
//                       GPS, so this stands in for it (pairing; and the accuracy check
//                       when the solve does not use it as priors)
//   <set>-intrinsics.json  the shared intrinsics (fx, fy, cx, cy, distortion), with
//                       their spread over the set
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { _test as lidar } from './lidar.mjs'

const [dir, ...sets] = process.argv.slice(2)
if (!dir) throw new Error('usage: mill19-prep.mjs <mill19 dir> [building|rubble …]')
const ORIGIN = { lat: 40.4433, lon: -79.9436, h: 300 } // arbitrary: the scale check is local

const zipOf = async (path) => unzipSync(new Uint8Array(await readFile(path)))
const entry = (z, suffix) => z[Object.keys(z).find((k) => k.endsWith(suffix))]
const f32 = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length))

for (const set of sets.length ? sets : ['building', 'rubble']) {
  const base = join(dir, `${set}-pixsfm`)
  const coords = await zipOf(join(base, 'coordinates.pt'))
  const pkl = Buffer.from(entry(coords, 'data.pkl'))
  const scale = pkl.readDoubleBE(pkl.indexOf(0x47, pkl.indexOf('pose_scale_factor')) + 1) // pickle BINFLOAT
  const origin = Array.from(f32(entry(coords, '/data/0')))
  const metaDir = join(base, 'train', 'metadata')
  const files = (await readdir(metaDir)).filter((f) => f.endsWith('.pt')).sort()
  const lines = [],
    K = []
  for (const f of files) {
    const z = await zipOf(join(metaDir, f))
    // Storage keys follow the pickle's order: 0 = c2w (3×4), 1 = intrinsics, 2 = distortion.
    const c2w = f32(entry(z, '/data/0')),
      intr = f32(entry(z, '/data/1')),
      dist = f32(entry(z, '/data/2'))
    const d = [c2w[3], c2w[7], c2w[11]].map((v, a) => v * scale + origin[a]) // down, right, back (m)
    const enu = [d[1], -d[2], -d[0]]
    const [lon, lat, h] = lidar.enuToGeodetic(enu, ORIGIN)
    lines.push(`${f.replace(/\.pt$/, '.jpg')}\t${lat.toFixed(10)}\t${lon.toFixed(10)}\t${h.toFixed(4)}`)
    K.push([...intr, ...dist])
  }
  const mean = (i) => K.reduce((s, k) => s + k[i], 0) / K.length
  const spread = (i) => Math.max(...K.map((k) => k[i])) - Math.min(...K.map((k) => k[i]))
  const intrinsics = {
    fx: mean(0),
    fy: mean(1),
    cx: mean(2),
    cy: mean(3),
    distortion: [mean(4), mean(5), mean(6), mean(7)],
    spread: { fx: spread(0), cx: spread(2), cy: spread(3), k1: spread(4) },
    images: K.length,
    scale,
    origin,
  }
  await writeFile(
    join(dir, `${set}-cameras.txt`),
    `# name\tlat\tlon\th (Mill19 ${set}, PixSFM centres → WGS84 around ${JSON.stringify(ORIGIN)})\n${lines.join('\n')}\n`,
  )
  await writeFile(join(dir, `${set}-intrinsics.json`), JSON.stringify(intrinsics, null, 2))
  console.log(set, JSON.stringify(intrinsics))
}
