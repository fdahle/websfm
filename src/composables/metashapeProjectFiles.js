// Import ▸ Metashape ▸ Project: the files of a Metashape project, read into what
// MetashapeImportModal shows (core/io/metashapeProject.js does the reading of their
// contents). A .psz is one zip with doc.xml and every asset at its top; a .psx folder
// has <name>.psx beside <name>.files/, a zip per part. Only the tie points and the mesh
// are read beyond the XML: the rest of a project (photos, depth maps, dense cloud, DEM,
// orthomosaic) is either here already or in formats of Metashape's own.
import { readSfmZip } from '../workers/archive/zipClient.js'
import { readMetashapeXml } from '../core/io/metashapeXml.js'
import { parseXml, child, childrenOf } from '../core/io/xmlLite.js'
import { parsePly } from '../core/io/ply.js'
import {
  metashapeMeshToModel,
  metashapeTiePoints,
  psxChunkPaths,
  readModelDoc,
  readPlyVertices,
  readPointCloudDoc,
  readPsxChunk,
} from '../core/io/metashapeProject.js'

const dec = new TextDecoder()
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '')

async function zipRead(file, wanted) {
  const { entries } = await readSfmZip(file, { wanted })
  return new Map(entries.map((e) => [e.path, e.data]))
}

// The tie points and mesh of one chunk, from `read(path) → bytes | null` (paths as the
// chunk's frame names them). Parsing a missing or unreadable part leaves it out with a note.
function chunkAssets(chunk, plys, meshBytes, notes) {
  const frame = chunk.frames[0]
  let tiePoints = null,
    mesh = null
  try {
    if (plys.projections.length) tiePoints = metashapeTiePoints(chunk, plys)
  } catch (err) {
    notes.push(`${chunk.label}: the tie points could not be read (${err?.message ?? err})`)
  }
  try {
    if (meshBytes) {
      const componentId = tiePoints?.model.images[0]?.componentId ?? null
      const buffer = meshBytes.buffer.slice(meshBytes.byteOffset, meshBytes.byteOffset + meshBytes.byteLength)
      mesh = metashapeMeshToModel(chunk, parsePly(buffer), componentId)
    }
  } catch (err) {
    notes.push(`${chunk.label}: the mesh could not be read (${err?.message ?? err})`)
  }
  return { tiePoints, mesh, has: frame?.has ?? {} }
}

const plyOf = (bytes) => (bytes ? readPlyVertices(bytes) : null)

async function readPsz(file) {
  const docs = await zipRead(file, ['doc.xml'])
  if (!docs.has('doc.xml')) throw new Error('This .psz holds no doc.xml')
  const doc = readMetashapeXml(dec.decode(docs.get('doc.xml')))
  const wanted = new Set()
  for (const c of doc.chunks) {
    const f = c.frames[0]
    const pc = f?.pointCloud
    if (pc?.tracks) wanted.add(pc.tracks)
    for (const p of pc?.points ?? []) wanted.add(p.path)
    for (const p of pc?.projections ?? []) wanted.add(p.path)
    if (f?.model?.mesh) wanted.add(f.model.mesh)
  }
  const bytes = wanted.size ? await zipRead(file, [...wanted]) : new Map()
  const notes = []
  const chunks = doc.chunks.map((c) => {
    const pc = c.frames[0]?.pointCloud
    const plys = {
      tracks: plyOf(bytes.get(pc?.tracks)),
      points: (pc?.points ?? []).map((p) => ({ componentId: p.componentId, ply: plyOf(bytes.get(p.path)) })),
      projections: (pc?.projections ?? []).map((p) => ({ cameraId: p.cameraId, ply: plyOf(bytes.get(p.path)) })),
    }
    return chunkAssets(c, plys, bytes.get(c.frames[0]?.model?.mesh) ?? null, notes)
  })
  return { fileName: file.name, doc, project: { chunks, notes } }
}

async function readPsx(files) {
  const rel = (f) => (f.webkitRelativePath || f.name).replace(/\\/g, '/')
  const psx = files.find((f) => /\.psx$/i.test(f.name))
  if (!psx) throw new Error('No .psx file in this folder')
  const base = rel(psx).replace(/\.psx$/i, '.files/')
  const byPath = new Map(files.map((f) => [rel(f), f]))
  const fileAt = (path) => byPath.get(base + path) ?? null
  const docOf = async (path) => {
    const f = fileAt(path)
    if (!f) return null
    const m = await zipRead(f, ['doc.xml'])
    return m.has('doc.xml') ? dec.decode(m.get('doc.xml')) : null
  }
  const projectXml = await docOf('project.zip')
  if (!projectXml)
    throw new Error(`${base}project.zip is missing: pick the folder that holds the .psx and its .files folder`)
  const chunkPaths = psxChunkPaths(projectXml)
  const chunks = [],
    assets = [],
    notes = []
  for (const chunkPath of chunkPaths) {
    const chunkXml = await docOf(chunkPath)
    if (!chunkXml) continue
    const chunkDir = dirOf(chunkPath)
    const frameDocs = new Map()
    for (const f of childrenOf(child(parseXml(chunkXml), 'frames'), 'frame'))
      if (f.attrs.path) frameDocs.set(f.attrs.path, await docOf(chunkDir + f.attrs.path))
    const chunk = readPsxChunk(chunkXml, (p) => frameDocs.get(p) ?? null)
    chunks.push(chunk)
    // The first frame's parts, each a zip of its own beside frame.zip.
    const framePath = [...frameDocs.keys()][0]
    const frameDir = chunkDir + dirOf(framePath ?? '')
    const frame = chunk.frames[0]
    const plys = { tracks: null, points: [], projections: [] }
    if (frame?.pointCloud?.path) {
      const zip = fileAt(frameDir + frame.pointCloud.path)
      if (zip) {
        const docXml = (await zipRead(zip, ['doc.xml'])).get('doc.xml')
        const list = docXml ? readPointCloudDoc(dec.decode(docXml)) : null
        if (list) {
          const names = [list.tracks, ...list.points.map((p) => p.path), ...list.projections.map((p) => p.path)]
          const bytes = await zipRead(zip, names.filter(Boolean))
          plys.tracks = plyOf(bytes.get(list.tracks))
          plys.points = list.points.map((p) => ({ componentId: p.componentId, ply: plyOf(bytes.get(p.path)) }))
          plys.projections = list.projections.map((p) => ({ cameraId: p.cameraId, ply: plyOf(bytes.get(p.path)) }))
        }
      } else notes.push(`${chunk.label}: its tie points (${frame.pointCloud.path}) are not in the folder`)
    }
    let meshBytes = null
    if (frame?.model?.path) {
      const zip = fileAt(frameDir + frame.model.path)
      const docXml = zip ? (await zipRead(zip, ['doc.xml'])).get('doc.xml') : null
      const name = docXml ? readModelDoc(dec.decode(docXml)) : null
      if (name) meshBytes = (await zipRead(zip, [name])).get(name) ?? null
    }
    assets.push(chunkAssets(chunk, plys, meshBytes, notes))
  }
  if (!chunks.length) throw new Error('The project holds no chunk this folder has the files of')
  return { fileName: psx.name, doc: { version: null, chunks }, project: { chunks: assets, notes } }
}

/** files: a .psz File, or the files of a picked folder holding a .psx. */
export async function readMetashapeProject(files) {
  const list = [...(files || [])]
  // A picked folder is the .psx's, even when a .psz copy sits beside it.
  if (list.some((f) => /\.psx$/i.test(f.name))) return readPsx(list)
  const psz = list.find((f) => /\.psz$/i.test(f.name))
  if (!psz) throw new Error('Pick a .psz file, or the folder that holds a .psx and its .files folder')
  return readPsz(psz)
}
