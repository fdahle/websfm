// Keypoints and matches from plain text or CSV (Import ▸ Keypoints, Import ▸ Matches): what
// another detector or matcher writes, without its own project format. Pure: text in,
// plain arrays out; the import (composables/useFeatureImport.js) matches the names to
// the project's images and checks the indices.
//
// Keypoints, in pixels with the origin at the image's top-left corner (as COLMAP):
//   • a table with an image column: `image,x,y[,scale,orientation]`, one row per keypoint;
//   • one file per image, named after it (`IMG_0001.txt`, `IMG_0001.jpg.csv`): `x y
//     [scale orientation]` rows;
//   • Lowe's SIFT `.key` files (Bundler, VisualSFM): `N D`, then per keypoint `row col
//     scale orientation` and D descriptor values, which are not read.
// Matches:
//   • COLMAP's custom-match blocks: a line `IMG_1.jpg IMG_2.jpg`, then `idx1 idx2` lines,
//     a blank line before the next pair;
//   • a table `imageA,imageB,indexA,indexB`, one row per match;
//   • a table `imageA,xA,yA,imageB,xB,yB`: matched points by position, for a matcher
//     that writes no keypoints; the keypoints are then the matched points.
// And WebSfM's own JSON exports (composables/exports/tabular.js), so a project's
// features read back whichever format they were saved in:
//   • keypoints: `[{ image, keypoints: [{ x, y, scale, response }] }]`;
//   • matches: `[{ imageA, imageB, matches: [[indexA, indexB], …] }]`. The pair list
//     alone (`[{ imageA, imageB, rawCount, inlierCount }]`) holds no matches to read.
// A file's delimiter is the comma, semicolon or tab its first line holds, else any run
// of spaces; a quoted cell ("IMG 1.jpg", "B,2.jpg") is one cell, as CSV writes it.
// `#` starts a comment line.

import { IMAGE_COLUMN, stem } from './nameMatch.js'

const isNum = (s) => s !== '' && Number.isFinite(Number(s))

function lines(text) {
  return String(text).replace(/^﻿/, '').split(/\r?\n/)
}

// The cells of a line, split as the file's first data line says (see above); empty
// cells at the end of a line (a trailing delimiter) are dropped.
function splitterFor(firstLine) {
  const delim = [',', ';', '\t'].find((d) => firstLine.includes(d))
  if (!delim) return (line) => line.trim().split(/\s+/).filter(Boolean)
  return (line) => {
    const out = []
    let cell = '',
      quoted = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quoted) {
        if (c !== '"') cell += c
        else if (line[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else if (c === '"' && !cell.trim()) {
        cell = ''
        quoted = true
      } else if (c === delim) {
        out.push(cell.trim())
        cell = ''
      } else cell += c
    }
    out.push(cell.trim())
    while (out.length && out.at(-1) === '') out.pop()
    return out
  }
}
const isComment = (line) => /^\s*#/.test(line)

// A per-image file names its image: `IMG_0001.jpg.txt` → IMG_0001.jpg, `IMG_0001.key` →
// IMG_0001 (the name resolver matches a stem too).
export const imageNameOfFile = (fileName) => stem(fileName)

const KEY_COLUMNS = {
  x: /^(x|col|column|u|px|x_?px)$/i,
  y: /^(y|row|v|py|y_?px)$/i,
  scale: /^(scale|size|sigma|s)$/i,
  angle: /^(angle|orientation|ori|theta|dir)$/i,
}

// Lowe's `.key`: "N D", then per keypoint "row col scale orientation" and D integers,
// laid out over any number of lines.
function readLoweKey(text, name) {
  const t = String(text).trim().split(/\s+/)
  const n = Number(t[0]),
    d = Number(t[1])
  if (!Number.isInteger(n) || !Number.isInteger(d) || n < 0 || d < 0) throw new Error(`${name}: not a .key file`)
  const need = 2 + n * (4 + d)
  if (t.length < need) throw new Error(`${name}: the file ends after ${t.length} of ${need} values`)
  const x = new Float32Array(n),
    y = new Float32Array(n),
    scale = new Float32Array(n),
    angle = new Float32Array(n)
  for (let i = 0, o = 2; i < n; i++, o += 4 + d) {
    y[i] = Number(t[o])
    x[i] = Number(t[o + 1])
    scale[i] = Number(t[o + 2])
    angle[i] = Number(t[o + 3])
  }
  return { name: imageNameOfFile(name), x, y, scale, angle }
}

function headerIndex(head, re) {
  return head.findIndex((h) => re.test(h))
}

// One table of keypoints, with an image column or for the one image the file is named after.
function readKeypointTable(rows, head, fileName) {
  const imageCol = head ? headerIndex(head, IMAGE_COLUMN) : -1
  let xCol, yCol, scaleCol, angleCol
  if (head) {
    xCol = headerIndex(head, KEY_COLUMNS.x)
    yCol = headerIndex(head, KEY_COLUMNS.y)
    scaleCol = headerIndex(head, KEY_COLUMNS.scale)
    angleCol = headerIndex(head, KEY_COLUMNS.angle)
    if (xCol < 0 || yCol < 0) throw new Error(`${fileName}: no x and y columns in the header`)
  } else {
    // No header: x y [scale angle], or image x y [scale angle] when the first value is a name.
    const first = rows[0] ?? []
    const named = first.length >= 3 && !isNum(first[0])
    const o = named ? 1 : 0
    ;[xCol, yCol, scaleCol, angleCol] = [o, o + 1, first.length > o + 2 ? o + 2 : -1, first.length > o + 3 ? o + 3 : -1]
    if (named) return groupKeypoints(rows, 0, xCol, yCol, scaleCol, angleCol)
  }
  if (imageCol >= 0) return groupKeypoints(rows, imageCol, xCol, yCol, scaleCol, angleCol)
  const name = imageNameOfFile(fileName)
  return [packKeypoints(name, rows, xCol, yCol, scaleCol, angleCol)]
}

function packKeypoints(name, rows, xCol, yCol, scaleCol, angleCol) {
  const n = rows.length
  const x = new Float32Array(n),
    y = new Float32Array(n),
    scale = scaleCol >= 0 ? new Float32Array(n) : null,
    angle = angleCol >= 0 ? new Float32Array(n) : null
  for (let i = 0; i < n; i++) {
    const r = rows[i]
    x[i] = Number(r[xCol])
    y[i] = Number(r[yCol])
    if (scale) scale[i] = Number(r[scaleCol]) || 0
    if (angle) angle[i] = Number(r[angleCol]) || 0
  }
  return { name, x, y, scale, angle }
}

function groupKeypoints(rows, imageCol, xCol, yCol, scaleCol, angleCol) {
  const byImage = new Map()
  for (const r of rows) {
    const name = r[imageCol]
    if (!byImage.has(name)) byImage.set(name, [])
    byImage.get(name).push(r)
  }
  return [...byImage].map(([name, list]) => packKeypoints(name, list, xCol, yCol, scaleCol, angleCol))
}

// COLMAP's custom-match text: blocks of "nameA nameB" then "i j" lines.
function readMatchBlocks(all, fileName, tokens) {
  const pairs = []
  let cur = null
  for (let k = 0; k < all.length; k++) {
    const line = all[k]
    if (isComment(line)) continue
    const t = tokens(line)
    if (!t.length) {
      cur = null
      continue
    }
    if (t.length === 2 && isNum(t[0]) && isNum(t[1])) {
      if (!cur) throw new Error(`${fileName}, line ${k + 1}: a match before the image pair it belongs to`)
      cur.idx.push(Number(t[0]), Number(t[1]))
      continue
    }
    if (t.length === 2) {
      cur = { a: t[0], b: t[1], idx: [] }
      pairs.push(cur)
      continue
    }
    throw new Error(`${fileName}, line ${k + 1}: expected two image names or two indices`)
  }
  return pairs.map((p) => ({ a: p.a, b: p.b, idx: Uint32Array.from(p.idx) }))
}

// Rows of matches, grouped into pairs in first-seen order.
function groupPairs(rows, cols, coords) {
  const byPair = new Map()
  for (const r of rows) {
    const a = r[cols[0]],
      b = r[coords ? cols[3] : cols[1]]
    const key = `${a}\u0000${b}`
    let p = byPair.get(key)
    if (!p) byPair.set(key, (p = { a, b, values: [] }))
    if (coords) p.values.push(Number(r[cols[1]]), Number(r[cols[2]]), Number(r[cols[4]]), Number(r[cols[5]]))
    else p.values.push(Number(r[cols[2]]), Number(r[cols[3]]))
  }
  return [...byPair.values()].map((p) =>
    coords ? { a: p.a, b: p.b, pts: Float64Array.from(p.values) } : { a: p.a, b: p.b, idx: Uint32Array.from(p.values) },
  )
}

const MATCH_HEADERS = {
  imageA: /^(image|img|photo|file|name)_?(a|1|0|left|from|src)$/i,
  imageB: /^(image|img|photo|file|name)_?(b|2|right|to|dst)$/i,
  indexA: /^(idx|index|kp|keypoint|feature|point)_?(a|1|0|left|from|src)$|^(a|1|left)_?(idx|index)$/i,
  indexB: /^(idx|index|kp|keypoint|feature|point)_?(b|2|right|to|dst)$|^(b|2|right)_?(idx|index)$/i,
  xA: /^x_?(a|1|0|left|from|src)$|^(a|1|left)_?x$/i,
  yA: /^y_?(a|1|0|left|from|src)$|^(a|1|left)_?y$/i,
  xB: /^x_?(b|2|right|to|dst)$|^(b|2|right)_?x$/i,
  yB: /^y_?(b|2|right|to|dst)$|^(b|2|right)_?y$/i,
}

/**
 * Read one file. → { kind: 'keypoints', images: [{ name, x, y, scale, angle }] }
 *                 | { kind: 'matches', pairs: [{ a, b, idx: Uint32Array (iA, iB, …) }] }
 *                 | { kind: 'point-matches', pairs: [{ a, b, pts: Float64Array (xA, yA, xB, yB, …) }] }
 * Throws with the file name and line on a file it cannot read.
 */
export function readFeatureFile(text, fileName = 'file') {
  if (/\.key$/i.test(fileName)) return { kind: 'keypoints', images: [readLoweKey(text, fileName)] }
  if (/\.json$/i.test(fileName) || /^\uFEFF?\s*[[{]/.test(String(text).slice(0, 64)))
    return readFeatureJson(text, fileName)
  const all = lines(text)
  const data = all.filter((l) => l.trim() && !isComment(l))
  if (!data.length) throw new Error(`${fileName}: the file is empty`)
  const tokens = splitterFor(data[0])
  const first = tokens(data[0])
  // Lowe's header ("N 128") followed by a four-number keypoint line.
  if (first.length === 2 && first.every(isNum) && data[1] && tokens(data[1]).length === 4 && Number(first[1]) >= 16)
    return { kind: 'keypoints', images: [readLoweKey(text, fileName)] }
  // Name pair, then index pairs: COLMAP's blocks (an `x,y` header is not one).
  const xyHeader = first.length === 2 && KEY_COLUMNS.x.test(first[0]) && KEY_COLUMNS.y.test(first[1])
  const second = data[1] ? tokens(data[1]) : []
  if (first.length === 2 && !first.some(isNum) && !xyHeader && second.length === 2 && second.every(isNum))
    return { kind: 'matches', pairs: readMatchBlocks(all, fileName, tokens) }

  const hasHeader = !first.some(isNum)
  const head = hasHeader ? first : null
  const rows = (hasHeader ? data.slice(1) : data).map(tokens)
  if (!rows.length) throw new Error(`${fileName}: a header but no rows`)

  if (head) {
    const col = Object.fromEntries(Object.entries(MATCH_HEADERS).map(([k, re]) => [k, headerIndex(head, re)]))
    if (col.imageA >= 0 && col.imageB >= 0) {
      if (col.xA >= 0 && col.yA >= 0 && col.xB >= 0 && col.yB >= 0)
        return {
          kind: 'point-matches',
          pairs: groupPairs(rows, [col.imageA, col.xA, col.yA, col.imageB, col.xB, col.yB], true),
        }
      if (col.indexA >= 0 && col.indexB >= 0)
        return { kind: 'matches', pairs: groupPairs(rows, [col.imageA, col.imageB, col.indexA, col.indexB], false) }
      throw new Error(`${fileName}: two image columns, but no index or x/y columns for each`)
    }
    return { kind: 'keypoints', images: readKeypointTable(rows, head, fileName) }
  }
  // No header: the column pattern says which.
  const r = rows[0]
  const pattern = r.map((v) => (isNum(v) ? 'n' : 's')).join('')
  if (pattern === 'ssnn') return { kind: 'matches', pairs: groupPairs(rows, [0, 1, 2, 3], false) }
  if (pattern === 'snnsnn') return { kind: 'point-matches', pairs: groupPairs(rows, [0, 1, 2, 3, 4, 5], true) }
  if (/^s?nn(n|nn)?$/.test(pattern)) return { kind: 'keypoints', images: readKeypointTable(rows, null, fileName) }
  throw new Error(`${fileName}: neither keypoints (x y) nor matches (imageA imageB indexA indexB) in its rows`)
}

// WebSfM's JSON exports: a list of images with their keypoints, or of pairs with their
// matches (keypoint indices into each image's keypoints).
function readFeatureJson(text, fileName) {
  let doc
  try {
    doc = JSON.parse(String(text).replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`${fileName}: not valid JSON (${err?.message ?? err})`)
  }
  if (!Array.isArray(doc)) throw new Error(`${fileName}: expected a list of images or of image pairs`)
  if (!doc.length) throw new Error(`${fileName}: the file is empty`)
  const first = doc[0] ?? {}
  if (Array.isArray(first.keypoints))
    return { kind: 'keypoints', images: doc.map((e, k) => jsonKeypoints(e, `${fileName}, entry ${k + 1}`)) }
  if ('imageA' in first && 'imageB' in first) {
    if (!doc.some((e) => Array.isArray(e?.matches)))
      throw new Error(
        `${fileName}: a list of image pairs without their matches (the export's pair list alone); ` +
          'export the matches themselves to import them',
      )
    return { kind: 'matches', pairs: doc.map((e, k) => jsonPair(e, `${fileName}, entry ${k + 1}`)) }
  }
  throw new Error(`${fileName}: neither keypoints ({ image, keypoints }) nor matches ({ imageA, imageB, matches })`)
}

function jsonKeypoints(e, where) {
  if (typeof e?.image !== 'string' || !Array.isArray(e.keypoints))
    throw new Error(`${where}: an image name and its keypoints expected`)
  const list = e.keypoints,
    n = list.length
  const x = new Float32Array(n),
    y = new Float32Array(n)
  const hasScale = list.some((p) => Number.isFinite(p?.scale)),
    hasAngle = list.some((p) => Number.isFinite(p?.angle ?? p?.orientation))
  const scale = hasScale ? new Float32Array(n) : null,
    angle = hasAngle ? new Float32Array(n) : null
  for (let i = 0; i < n; i++) {
    const p = list[i]
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) throw new Error(`${where}, keypoint ${i + 1}: no x and y`)
    x[i] = p.x
    y[i] = p.y
    if (scale) scale[i] = Number(p.scale) || 0
    if (angle) angle[i] = Number(p.angle ?? p.orientation) || 0
  }
  return { name: e.image, x, y, scale, angle }
}

function jsonPair(e, where) {
  if (typeof e?.imageA !== 'string' || typeof e?.imageB !== 'string')
    throw new Error(`${where}: two image names expected`)
  const list = Array.isArray(e.matches) ? e.matches : []
  const idx = new Uint32Array(list.length * 2)
  for (let k = 0; k < list.length; k++) {
    const m = list[k]
    if (!Array.isArray(m) || !Number.isInteger(m[0]) || !Number.isInteger(m[1]) || m[0] < 0 || m[1] < 0)
      throw new Error(`${where}, match ${k + 1}: two keypoint indices expected`)
    idx[2 * k] = m[0]
    idx[2 * k + 1] = m[1]
  }
  return { a: e.imageA, b: e.imageB, idx }
}

/**
 * Matched points by position → keypoints and index matches: each image's keypoints are
 * its matched points, one per position (to 1/100 px), so a point matched in several
 * pairs is one keypoint and its tracks join.
 * pairs [{ a, b, pts }] → { keypoints: Map name → { x, y }, pairs: [{ a, b, idx }] }
 */
export function keypointsFromPointMatches(pairs) {
  const byImage = new Map()
  const indexOf = (name, x, y) => {
    let img = byImage.get(name)
    if (!img) byImage.set(name, (img = { at: new Map(), x: [], y: [] }))
    const key = `${Math.round(x * 100)},${Math.round(y * 100)}`
    let i = img.at.get(key)
    if (i === undefined) {
      i = img.x.length
      img.at.set(key, i)
      img.x.push(x)
      img.y.push(y)
    }
    return i
  }
  const out = pairs.map(({ a, b, pts }) => {
    const idx = new Uint32Array(pts.length / 2)
    for (let k = 0, m = 0; k < pts.length; k += 4, m += 2) {
      idx[m] = indexOf(a, pts[k], pts[k + 1])
      idx[m + 1] = indexOf(b, pts[k + 2], pts[k + 3])
    }
    return { a, b, idx }
  })
  const keypoints = new Map(
    [...byImage].map(([name, v]) => [name, { name, x: Float32Array.from(v.x), y: Float32Array.from(v.y) }]),
  )
  return { keypoints, pairs: out }
}

/**
 * Index matches checked against the keypoint counts: a pair keeps its matches whose
 * indices exist in both images, and drops a match repeated or onto one keypoint twice.
 * → { idx: Uint32Array, invalid: number }
 */
export function validMatchIndices(idx, countA, countB) {
  const keep = []
  let invalid = 0
  const seen = new Set()
  for (let k = 0; k < idx.length; k += 2) {
    const ia = idx[k],
      ib = idx[k + 1]
    if (!(ia < countA) || !(ib < countB)) {
      invalid++
      continue
    }
    const key = ia * 4294967296 + ib
    if (seen.has(key)) continue
    seen.add(key)
    keep.push(ia, ib)
  }
  return { idx: Uint32Array.from(keep), invalid }
}
