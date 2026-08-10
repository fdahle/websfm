// Dedicated SQLite worker for COLMAP database.db files. It intentionally does
// not join the compute pool: the review modal holds one read-only DB session and
// later fetches only the components the user selected.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import {
  decodeColmapCamera, decodeColmapDescriptors, decodeColmapKeypoints,
  decodeColmapMatches, decodeColmapMatrix, pairIdToImageIds,
} from '../core/io/colmapDatabase.js'

let sqlitePromise
let db = null
let filename = null

const sqlite = () => (sqlitePromise ??= sqlite3InitModule())

function rows(sql, bind = undefined) {
  return db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' })
}
function scalar(sql, bind = undefined) {
  return db.exec({ sql, bind, rowMode: 0, returnValue: 'resultRows' })[0] ?? 0
}
function hasTable(name) {
  return !!scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", [name])
}

function closeDb() {
  try { db?.close() } catch { /* worker teardown is the final fallback */ }
  db = null
}

async function inspect(buffer, sourceName) {
  closeDb()
  const s = await sqlite()
  filename = `/colmap-${crypto.randomUUID()}.db`
  s.capi.sqlite3_js_posix_create_file(filename, new Uint8Array(buffer))
  db = new s.oo1.DB(filename, 'r')
  const required = ['cameras', 'images']
  if (!required.every(hasTable)) throw new Error('Not a COLMAP database (cameras/images tables missing)')

  const cameraRows = rows('SELECT camera_id, model, width, height, params FROM cameras ORDER BY camera_id')
  const cameras = cameraRows.map(decodeColmapCamera)
  const images = rows('SELECT image_id, name, camera_id FROM images ORDER BY image_id')
    .map((r) => ({ externalId: Number(r.image_id), name: r.name, cameraId: Number(r.camera_id) }))
  const featureCounts = new Map()
  if (hasTable('keypoints')) for (const r of rows('SELECT image_id, rows, cols FROM keypoints ORDER BY image_id')) {
    featureCounts.set(Number(r.image_id), { imageId: Number(r.image_id), keypointCount: Number(r.rows), keypointCols: Number(r.cols), descriptorType: null, descriptorDim: null })
  }
  if (hasTable('descriptors')) for (const r of rows('SELECT image_id, rows, cols FROM descriptors ORDER BY image_id')) {
    const f = featureCounts.get(Number(r.image_id)) ?? { imageId: Number(r.image_id), keypointCount: 0, keypointCols: 0 }
    const b = Number(r.cols)
    Object.assign(f, { descriptorType: b === 128 ? 'SIFT uint8' : b === 512 ? 'ALIKED float32' : `Unknown (${b} bytes/row)`, descriptorDim: b === 128 || b === 512 ? 128 : null })
    featureCounts.set(Number(r.image_id), f)
  }
  const pairTable = hasTable('two_view_geometries') ? 'two_view_geometries' : hasTable('matches') ? 'matches' : null
  const pairs = pairTable ? rows(`SELECT pair_id, rows FROM ${pairTable} WHERE rows > 0 ORDER BY pair_id`)
    .map((r) => ({ pairId: Number(r.pair_id), imageIds: pairIdToImageIds(Number(r.pair_id)), verifiedCount: pairTable === 'two_view_geometries' ? Number(r.rows) : 0, rawCount: pairTable === 'matches' ? Number(r.rows) : 0 })) : []

  return {
    format: 'colmap-database', sourceName, bytes: buffer.byteLength,
    userVersion: Number(scalar('PRAGMA user_version')),
    cameras: cameras.map((c) => ({ externalId: c.cameraId, model: c.model, width: c.width, height: c.height, supported: c.supported, losses: c.losses })),
    unsupportedCameras: cameras.filter((c) => !c.supported).length,
    images, features: [...featureCounts.values()], pairs,
    rigs: hasTable('rigs') ? Number(scalar('SELECT count(*) FROM rigs')) : 0,
    frames: hasTable('frames') ? Number(scalar('SELECT count(*) FROM frames')) : 0,
    posePriors: hasTable('pose_priors') ? Number(scalar('SELECT count(*) FROM pose_priors')) : 0,
    hasKeypoints: hasTable('keypoints'), hasDescriptors: hasTable('descriptors'),
    hasRawMatches: hasTable('matches'), hasVerifiedMatches: hasTable('two_view_geometries'),
  }
}

function readSelected(options = {}) {
  if (!db) throw new Error('COLMAP database session is closed')
  const out = { cameras: [], images: [], features: [], pairs: [] }
  if (options.calibration) {
    out.cameras = rows('SELECT camera_id, model, width, height, params FROM cameras ORDER BY camera_id').map(decodeColmapCamera)
    out.images = rows('SELECT image_id, name, camera_id FROM images ORDER BY image_id')
      .map((r) => ({ imageId: Number(r.image_id), name: r.name, cameraId: Number(r.camera_id) }))
  }
  if (options.features && hasTable('keypoints')) {
    const descByImage = new Map()
    if (options.descriptors && hasTable('descriptors')) {
      for (const r of rows('SELECT image_id, rows, cols, data FROM descriptors ORDER BY image_id')) descByImage.set(Number(r.image_id), decodeColmapDescriptors(r))
    }
    for (const r of rows('SELECT image_id, rows, cols, data FROM keypoints ORDER BY image_id')) {
      const imageId = Number(r.image_id)
      out.features.push({ imageId, keypoints: decodeColmapKeypoints(r), ...(descByImage.get(imageId) ?? { descriptors: null, descriptorType: null, descDim: null, compatible: false }) })
    }
  }
  if (options.matches) {
    const verified = options.matchSource !== 'raw' && hasTable('two_view_geometries')
    const table = verified ? 'two_view_geometries' : hasTable('matches') ? 'matches' : null
    if (table) {
      const sql = verified
        ? 'SELECT pair_id, rows, cols, data, F, E, H, config FROM two_view_geometries WHERE rows > 0 ORDER BY pair_id'
        : 'SELECT pair_id, rows, cols, data FROM matches WHERE rows > 0 ORDER BY pair_id'
      out.pairs = rows(sql).map((r) => ({
        pairId: Number(r.pair_id), imageIds: pairIdToImageIds(Number(r.pair_id)),
        matches: decodeColmapMatches(r), verified,
        F: verified ? decodeColmapMatrix(r.F, `pair ${r.pair_id} F`) : null,
        E: verified ? decodeColmapMatrix(r.E, `pair ${r.pair_id} E`) : null,
        H: verified ? decodeColmapMatrix(r.H, `pair ${r.pair_id} H`) : null,
        config: verified ? Number(r.config) : null,
      }))
    }
  }
  return out
}

function transferOf(result) {
  const transfer = []
  for (const f of result.features ?? []) if (f.descriptors?.buffer) transfer.push(f.descriptors.buffer)
  return transfer
}

function f64Blob(values) {
  const a = new Float64Array(values)
  return new Uint8Array(a.buffer)
}
function f32Blob(values) {
  const a = values instanceof Float32Array ? values : new Float32Array(values)
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
}
function u32Blob(pairs) {
  const a = new Uint32Array(pairs.length * 2)
  pairs.forEach(([x, y], i) => { a[i * 2] = x; a[i * 2 + 1] = y })
  return new Uint8Array(a.buffer)
}

async function exportDatabase(bundle) {
  closeDb()
  const s = await sqlite()
  const outDb = new s.oo1.DB(':memory:', 'ct')
  try {
    outDb.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE cameras(camera_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, model INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, params BLOB, prior_focal_length INTEGER NOT NULL);
      CREATE TABLE images(image_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name TEXT NOT NULL UNIQUE, camera_id INTEGER NOT NULL, prior_qw REAL, prior_qx REAL, prior_qy REAL, prior_qz REAL, prior_tx REAL, prior_ty REAL, prior_tz REAL);
      CREATE TABLE keypoints(image_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);
      CREATE TABLE descriptors(image_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);
      CREATE TABLE matches(pair_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB);
      CREATE TABLE two_view_geometries(pair_id INTEGER PRIMARY KEY NOT NULL, rows INTEGER NOT NULL, cols INTEGER NOT NULL, data BLOB, config INTEGER NOT NULL, F BLOB, E BLOB, H BLOB, qvec BLOB, tvec BLOB);
    `)
    outDb.exec('BEGIN')
    for (const c of bundle.cameras) outDb.exec({ sql: 'INSERT INTO cameras(camera_id,model,width,height,params,prior_focal_length) VALUES(?,?,?,?,?,1)', bind: [c.cameraId, 1, c.width, c.height, f64Blob(c.params)] })
    for (const im of bundle.images) outDb.exec({ sql: 'INSERT INTO images(image_id,name,camera_id) VALUES(?,?,?)', bind: [im.imageId, im.name, im.cameraId] })
    for (const f of bundle.features) {
      const xy = new Float32Array(f.keypoints.length * 2)
      f.keypoints.forEach((kp, i) => { xy[i * 2] = kp.x; xy[i * 2 + 1] = kp.y })
      outDb.exec({ sql: 'INSERT INTO keypoints(image_id,rows,cols,data) VALUES(?,?,2,?)', bind: [f.imageId, f.keypoints.length, f32Blob(xy)] })
      if (f.descriptors) outDb.exec({ sql: 'INSERT INTO descriptors(image_id,rows,cols,data) VALUES(?,?,128,?)', bind: [f.imageId, f.keypoints.length, f.descriptors] })
    }
    for (const p of bundle.pairs) {
      const pairId = p.pairId
      const data = u32Blob(p.matches)
      outDb.exec({ sql: 'INSERT INTO matches(pair_id,rows,cols,data) VALUES(?,?,2,?)', bind: [pairId, p.matches.length, data] })
      outDb.exec({ sql: 'INSERT INTO two_view_geometries(pair_id,rows,cols,data,config,F,E,H) VALUES(?,?,2,?,2,?,?,?)', bind: [pairId, p.matches.length, data, p.F ? f64Blob(p.F.flat()) : null, p.E ? f64Blob(p.E.flat()) : null, p.H ? f64Blob(p.H.flat()) : null] })
    }
    outDb.exec('COMMIT')
    return s.capi.sqlite3_js_db_export(outDb)
  } catch (err) {
    try { outDb.exec('ROLLBACK') } catch { /* no active transaction */ }
    throw err
  } finally {
    outDb.close()
  }
}

self.onmessage = async ({ data }) => {
  const { id, op, args = [] } = data
  try {
    let result
    if (op === 'inspect') result = await inspect(...args)
    else if (op === 'read') result = readSelected(...args)
    else if (op === 'export') result = await exportDatabase(...args)
    else if (op === 'close') { closeDb(); result = true }
    else throw new Error(`Unknown COLMAP DB op: ${op}`)
    const transfer = result instanceof Uint8Array ? [result.buffer] : transferOf(result)
    self.postMessage({ id, ok: true, result }, transfer)
  } catch (err) {
    closeDb()
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) })
  }
}
