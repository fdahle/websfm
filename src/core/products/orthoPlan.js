// How a tiled orthophoto visits its maps: block groups, the visit sequence, the
// replayed MIN cache that prices a grouping, and the cache log. ortho.js
// orthorectifyTiled plans with these. Pure: no Vue/Pinia/OPFS/DOM.
import { formatBytes } from '../formatBytes.js'
import { NO_LABEL } from './orthoWindow.js'

// What the ortho's map/photo cache can hold against what one block needs, as a log
// entry. Fewer entries than a block's maps re-read (and re-decode) every map of that
// block on each pass, which is most of the run time when it happens.
// `streamed`: an entry is a depth map's planes and its photo, else the photo alone.
export function orthoCacheLog(cacheBytes, entryBytes, maxMaps, { mosaic = false, streamed = true } = {}) {
  const fit = Math.floor(cacheBytes / entryBytes)
  const head =
    `Ortho: the map/photo cache (${formatBytes(cacheBytes)}) holds about ${fit} ` +
    `${streamed ? 'depth maps with their photos' : 'decoded photos'} (up to ${formatBytes(entryBytes)} each); ` +
    `one block sees up to ${maxMaps} maps`
  if (fit >= maxMaps) return [head, 'info', 'Products']
  return [
    `${head}, so ${mosaic ? 'its passes re-read and re-decode' : 'it re-reads and re-decodes'} the photos ` +
      'of the busiest blocks. A coarser GSD (smaller photo decodes) or a higher memory budget ' +
      '(Settings ▸ Compute) avoids it',
    'warn',
    'Products',
  ]
}

// Blocks in groups of about `size`: a rectangle of neighbouring blocks (squarer is
// better — fewer maps on its rim), the groups in serpentine row order so the next group
// starts beside the last one. Each group lists block indices in row-major order.
export function blockGroups(nbx, nby, size) {
  const n = Math.max(1, Math.min(nbx * nby, Math.floor(size) || 1))
  let gx = Math.min(nbx, Math.max(1, Math.round(Math.sqrt(n))))
  let gy = Math.min(nby, Math.max(1, Math.floor(n / gx)))
  if (gx * gy < n && gx < nbx) gx = Math.min(nbx, Math.ceil(n / gy))
  const groups = []
  for (let ty = 0, row = 0; ty < nby; ty += gy, row++) {
    const xs = []
    for (let tx = 0; tx < nbx; tx += gx) xs.push(tx)
    if (row % 2) xs.reverse()
    for (const tx of xs) {
      const g = []
      for (let by = ty; by < Math.min(nby, ty + gy); by++)
        for (let bx = tx; bx < Math.min(nbx, tx + gx); bx++) g.push(by * nbx + bx)
      groups.push(g)
    }
  }
  return groups
}

// The order a run visits maps: per group, per pass, the group's maps — ascending on
// even passes, descending on odd ones (each pass starts on what the last left cached).
const passOrder = (maps, k) => (k % 2 ? [...maps].reverse() : maps)

export function visitSequence(groupMaps, passes) {
  const seq = []
  for (const maps of groupMaps) for (let k = 0; k < passes; k++) for (const mi of passOrder(maps, k)) seq.push(mi)
  return seq
}

// Relative cost of a cache miss: a photo read and decode against a map's planes read
// (quarry-347, 2026-10-20: ~0.2–0.3 s against ~0.07 s).
const PHOTO_COST = 3,
  MAP_COST = 1

// P6: the group size that costs the fewest reads — each candidate's visit sequence
// replayed through a farthest-next-use cache (the run's own policy) of what the cache
// keeps after the group's working planes. With `entrySizes` ([{ map, photo }] per map, the
// EXPECTED bytes: planes, and the photo at its decode size) the replay counts bytes as the
// run does; without, every entry is `entryBytes`. The worst-case entry made a big cache
// look far worse than it is (quarry-347 at long side 12,000: block by block predicted
// 16,539, ran at ~4,000), so the run passes expected sizes. A mosaic's first pass needs
// no photo. A larger group must save ≥ 3 %: it holds more memory for less cache.
// → { size, predicted: { [size]: cost } }
// `owners` (per block, the Set of maps the graph cut gives part of it): a mosaic's colour
// passes decode only those maps' photos — of the 238 maps that see a quarry block at long
// side 12,000 a few dozen own any of it — so without them every visible map would count
// as a decode, which overrated both plans (10,302 predicted against ~4,000 run).
export function chooseGroupSize(
  nbx,
  nby,
  blocks,
  passes,
  mosaic,
  { cacheBytes, blockBytes, entryBytes, mapsResident = false, entrySizes = null, owners = null },
) {
  const nBlocks = nbx * nby
  const predicted = {}
  let best = { size: 1, cost: Infinity }
  if (!(entryBytes > 0)) return { size: 1, predicted }
  for (const size of [1, 2, 4, 6, 9, 12, 16, 20, 25, 30, 36, 49, 64]) {
    if (size > 1 && size > nBlocks) break
    const room = cacheBytes - (size - 1) * blockBytes
    const cap = Math.floor(room / entryBytes)
    if (cap < 1) break
    const groupList = blockGroups(nbx, nby, size)
    const groupMaps = groupList.map((g) => unionMaps(g.map((bi) => blocks[bi])))
    const seq = visitSequence(groupMaps, passes)
    // Per visit: 1 = the map's planes (a label pass), 2 = also its photo, 0 = a colour pass
    // skipping a map that owns nothing of the group (only its next use moves).
    const kinds = []
    for (let gi = 0; gi < groupMaps.length; gi++) {
      const own = owners ? new Set(groupList[gi].flatMap((bi) => [...owners[bi]])) : null
      for (let k = 0; k < passes; k++) {
        for (const mi of passOrder(groupMaps[gi], k))
          kinds.push(!mosaic ? 2 : k === 0 ? 1 : own && !own.has(mi) ? 0 : 2)
      }
    }
    const cost = replayCache(seq, kinds, entrySizes ? room : cap, mapsResident ? 0 : MAP_COST, entrySizes)
    predicted[size] = cost
    if (cost < best.cost * 0.97) best = { size, cost }
  }
  return { size: best.size, predicted }
}

// The cost of a visit sequence through a cache that evicts the entry wanted farthest
// ahead: a miss reads the map (`mapCost`), a visit that needs the photo decodes it unless
// the cached entry already has it. The cache holds `cap` entries, or with `sizes`
// (per map { map, photo } bytes) `cap` bytes.
function replayCache(seq, kinds, cap, mapCost, sizes = null) {
  const next = new Float64Array(seq.length),
    seen = new Map()
  for (let p = seq.length - 1; p >= 0; p--) {
    next[p] = seen.get(seq[p]) ?? Infinity
    seen.set(seq[p], p)
  }
  const cache = new Map() // mi → { next, photo, bytes }
  let cost = 0,
    held = 0
  const over = () => (sizes ? held > cap : cache.size > cap)
  for (let p = 0; p < seq.length; p++) {
    const mi = seq[p]
    let e = cache.get(mi)
    if (kinds[p] === 0) {
      if (e) e.next = next[p]
      continue
    }
    if (!e) {
      cost += mapCost
      e = { next: 0, photo: false, bytes: sizes ? sizes[mi].map : 1 }
      cache.set(mi, e)
      held += e.bytes
    }
    if (kinds[p] === 2 && !e.photo) {
      cost += PHOTO_COST
      e.photo = true
      if (sizes) {
        e.bytes += sizes[mi].photo
        held += sizes[mi].photo
      }
    }
    e.next = next[p]
    for (const [k, v] of cache)
      if (v.next === Infinity) {
        cache.delete(k)
        held -= v.bytes
      }
    while (over() && cache.size) {
      let worst = -1,
        far = -Infinity
      for (const [k, v] of cache)
        if (v.next > far) {
          far = v.next
          worst = k
        }
      held -= cache.get(worst).bytes
      cache.delete(worst)
    }
  }
  return cost
}

// The maps the graph cut (its coarse label grid) gives a part of block b's window, of
// those the block sees.
export function ownersFromCut({ labels, grid: { f, cw } }, b) {
  const sees = new Set(b.maps),
    own = new Set()
  const c0 = Math.floor(b.ex0 / f),
    c1 = Math.floor((b.ex0 + b.ew - 1) / f)
  const r0 = Math.floor(b.ey0 / f),
    r1 = Math.floor((b.ey0 + b.eh - 1) / f)
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const l = labels[r * cw + c]
      if (l !== NO_LABEL && sees.has(l)) own.add(l)
    }
  return own
}

// The maps any of these blocks sees, ascending.
export function unionMaps(blocks) {
  const set = new Set()
  for (const b of blocks) for (const mi of b.maps) set.add(mi)
  return [...set].sort((a, b) => a - b)
}

export function viewBytes(m) {
  let n = 0
  for (const v of Object.values(m)) if (ArrayBuffer.isView(v)) n += v.byteLength
  return n
}
