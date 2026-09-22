import { ref } from 'vue'
import { readSfmZip } from '../workers/archive/zipClient.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { makeNameResolver } from '../core/io/nameMatch.js'
import { cameraToWebsfmSensor } from '../core/io/colmapDatabase.js'
import { parseColmapModel, parseColmapModelBin, readColmapModel } from '../core/io/colmapModel.js'
import { inspectColmapDatabase, readColmapDatabase, disposeColmapDatabase } from '../workers/colmapDbClient.js'
import { useLog } from './useLog.js'
import { parseSfmText } from '../core/io/sfmInterop.js'

const MODEL_FILES = new Map([
  ['cameras.txt', 'cameras.txt'], ['images.txt', 'images.txt'], ['points3d.txt', 'points3D.txt'],
  ['cameras.bin', 'cameras.bin'], ['images.bin', 'images.bin'], ['points3d.bin', 'points3D.bin'],
])
const IMAGE_EXT = /\.(?:jpe?g|png|tiff?|webp|bmp)$/i
const DB_EXT = /(?:^|\/)(?:database\.(?:db|sqlite)|[^/]+\.(?:db|sqlite))$/i

const cleanPath = (path) => String(path || '').replace(/\\/g, '/').replace(/^\.\//, '')
const baseName = (path) => cleanPath(path).split('/').pop()

function safeArchivePath(path) {
  const p = cleanPath(path)
  return p && !p.startsWith('/') && !p.split('/').includes('..')
}

function modelSummary(files, name) {
  const binary = !!(files['cameras.bin'] || files['images.bin'] || files['points3D.bin'])
  const complete = binary
    ? !!(files['cameras.bin'] && files['images.bin'])
    : !!(files['cameras.txt'] && files['images.txt'])
  if (!complete) return { externalId: name, name, complete: false, registeredImages: 0, pointCount: 0, observationCount: 0 }
  try {
    const parsed = binary ? parseColmapModelBin(files) : parseColmapModel(files)
    const model = readColmapModel(parsed)
    return {
      externalId: name, name, complete: true,
      registeredImages: model.images.length,
      pointCount: model.points.length,
      observationCount: model.points.reduce((n, p) => n + p.views.length, 0),
    }
  } catch (err) {
    return { externalId: name, name, complete: false, registeredImages: 0, pointCount: 0, observationCount: 0, error: err?.message ?? String(err) }
  }
}

// Format-neutral UI coordinator; COLMAP is the first adapter. Reading only
// populates `importSession`. Store mutations happen exclusively in commitImport.
export function useSfmInterop({ addImages, importColmapModel, importInteropModel, activateTab }) {
  const imagesStore = useImagesStore()
  const matchesStore = useMatchesStore()
  const sensorsStore = useSensorsStore()
  const { log } = useLog()
  const importSession = ref(null)
  let importController = null

  async function entriesFrom(files, signal) {
    const entries = []
    const lazyImages = []
    for (const file of files) {
      const path = cleanPath(file.webkitRelativePath || file.name)
      if (/\.zip$/i.test(file.name)) {
        const { entries: archive, names } = await readSfmZip(file, { signal })
        for (const path of names) {
          if (IMAGE_EXT.test(path) && /(?:^|\/)images?\//i.test(path)) lazyImages.push({ path, archiveFile: file })
        }
        for (const entry of archive) entries.push({ ...entry, sourceName: file.name })
      } else {
        entries.push({ path, file, sourceName: file.name })
        if (IMAGE_EXT.test(path) && /(?:^|\/)images?\//i.test(path)) lazyImages.push({ path, file })
      }
    }
    return { entries, lazyImages }
  }

  async function materializeImages(items, signal) {
    const files = items.filter((x) => x.file).map((x) => x.file)
    const byArchive = new Map()
    for (const item of items.filter((x) => x.archiveFile)) {
      if (!byArchive.has(item.archiveFile)) byArchive.set(item.archiveFile, new Set())
      byArchive.get(item.archiveFile).add(item.path)
    }
    for (const [archiveFile, wanted] of byArchive) {
      const { entries } = await readSfmZip(archiveFile, { wanted: [...wanted], signal })
      for (const { path, data } of entries) files.push(new File([data], baseName(path), { type: '' }))
    }
    return files
  }

  async function openImport(fileList) {
    const files = [...(fileList || [])]
    if (!files.length) return
    importController?.abort()
    importController = new AbortController()
    const signal = importController.signal
    disposeColmapDatabase()
    importSession.value = { status: 'inspecting', sourceName: files.length === 1 ? files[0].name : `${files.length} selected files` }
    try {
      if (files.length === 1 && /\.(?:json|nvm)$/i.test(files[0].name)) {
        const text = await files[0].text()
        signal.throwIfAborted()
        const model = parseSfmText(text, files[0].name)
        const resolve = makeNameResolver(imagesStore.images, { key: 'uuid' })
        const matchedImages = model.images.filter((im) => resolve(im.name)).length
        importSession.value = {
          status: 'ready', format: model.format, sourceName: files[0].name,
          database: null,
          models: [{ externalId: 'model', name: model.format, complete: true, registeredImages: model.images.length, pointCount: model.points.length, observationCount: model.points.reduce((n, p) => n + (p.views?.length ?? 0), 0) }],
          genericModel: model, bundledImages: [],
          counts: { externalImages: model.images.length, matchedImages, bundledImages: 0 },
          warnings: model.warnings ?? [], error: null,
        }
        return
      }
      const { entries, lazyImages } = await entriesFrom(files, signal)
      signal.throwIfAborted()
      const dbEntry = entries.find((e) => DB_EXT.test(e.path)) ?? null
      const modelGroups = new Map()
      const bundledImages = lazyImages

      for (const entry of entries) {
        const base = baseName(entry.path).toLowerCase()
        const canonical = MODEL_FILES.get(base)
        if (canonical) {
          const slash = entry.path.lastIndexOf('/')
          const group = slash >= 0 ? entry.path.slice(0, slash) : 'sparse model'
          if (!modelGroups.has(group)) modelGroups.set(group, {})
          const bytes = entry.data ?? new Uint8Array(await entry.file.arrayBuffer())
          modelGroups.get(group)[canonical] = canonical.endsWith('.txt') ? new TextDecoder().decode(bytes) : new Uint8Array(bytes)
        }
      }

      let database = null
      if (dbEntry) {
        const dbFile = dbEntry.file ?? new File([dbEntry.data], baseName(dbEntry.path), { type: 'application/vnd.sqlite3' })
        database = await inspectColmapDatabase(dbFile)
        signal.throwIfAborted()
      }
      const models = [...modelGroups].map(([name, model]) => ({ ...modelSummary(model, name), files: model }))
      if (!database && !models.some((m) => m.complete)) throw new Error('No COLMAP database or complete sparse model was found')

      const resolve = makeNameResolver(imagesStore.images, { key: 'uuid' })
      const externalImages = database?.images ?? []
      const matchedImages = externalImages.filter((im) => resolve(im.name)).length
      const warnings = [...(database?.warnings ?? [])]
      if (database?.unsupportedCameras) warnings.push(`${database.unsupportedCameras} fisheye/unsupported camera model(s) will be skipped`)
      if (database?.rigs || database?.frames) warnings.push('Rig/frame records are detected but rig constraints are not imported')
      if (database?.posePriors) warnings.push(`${database.posePriors} pose prior(s) detected; their coordinate reference is not self-describing and they will be skipped`)
      for (const model of models) if (!model.complete) warnings.push(`${model.name}: ${model.error || 'incomplete sparse model'}`)
      if (database && !models.length) warnings.push('A database contains feature data, but no reconstructed sparse 3D model')
      if (!bundledImages.length && externalImages.length > matchedImages) warnings.push(`${externalImages.length - matchedImages} external image(s) are not loaded or bundled`)

      importSession.value = {
        status: 'ready', format: 'COLMAP', sourceName: importSession.value.sourceName,
        database, models, modelGroups, bundledImages,
        counts: { externalImages: externalImages.length, matchedImages, bundledImages: bundledImages.length },
        warnings, error: null,
      }
    } catch (err) {
      if (signal.aborted) return
      disposeColmapDatabase()
      importSession.value = { ...importSession.value, status: 'error', error: err?.message ?? String(err) }
      log(`SfM project inspection failed: ${err?.message ?? err}`, 'error', 'Import')
    }
  }

  function closeImport() {
    importController?.abort()
    disposeColmapDatabase()
    importSession.value = null
  }

  async function commitImport(options) {
    const session = importSession.value
    if (!session || session.status !== 'ready') return
    const signal = importController?.signal
    session.status = 'importing'
    session.error = null
    try {
      // Read and validate all selected database blobs before mutating a store.
      const selected = session.database ? await readColmapDatabase({
        calibration: !!options.calibration,
        features: !!options.features,
        descriptors: !!options.descriptors,
        matches: !!options.matches,
        matchSource: options.matchSource,
      }) : { cameras: [], images: [], features: [], pairs: [] }

      if (options.images && session.bundledImages.length) await addImages(await materializeImages(session.bundledImages, signal))
      const resolve = makeNameResolver(imagesStore.images, { key: 'uuid' })
      const dbImages = session.database?.images ?? []
      const uuidByExternal = new Map(dbImages.map((im) => [im.externalId, resolve(im.name)]).filter(([, uuid]) => uuid))

      if (options.calibration) {
        const referenced = new Set(dbImages.filter((im) => uuidByExternal.has(im.externalId)).map((im) => im.cameraId))
        const cameraGroups = selected.cameras.map(cameraToWebsfmSensor).filter((c) => c && referenced.has(c.externalId))
        const bindings = dbImages.filter((im) => uuidByExternal.has(im.externalId))
          .map((im) => ({ uuid: uuidByExternal.get(im.externalId), cameraId: im.cameraId }))
        await sensorsStore.importCameraGroups(cameraGroups, bindings)
      }

      const importedFeatureCounts = new Map()
      if (options.features) {
        const featureEntries = selected.features.filter((f) => uuidByExternal.has(f.imageId)).map((f) => {
          importedFeatureCounts.set(f.imageId, f.keypoints.length)
          return {
            uuid: uuidByExternal.get(f.imageId), keypoints: f.keypoints,
            descriptors: options.descriptors && f.compatible ? f.descriptors : null,
            descDim: f.descDim ?? 128, detector: f.descriptorType?.startsWith('aliked') ? 'aliked' : 'sift', source: 'colmap',
          }
        })
        await imagesStore.importFeatures(featureEntries, { invalidateMatches: true })
      }

      if (options.matches) {
        if (!options.features) throw new Error('COLMAP matches require importing the matching keypoint index space')
        const pairEntries = []
        let invalid = 0
        for (const pair of selected.pairs) {
          const [a, b] = pair.imageIds
          const uuidA = uuidByExternal.get(a), uuidB = uuidByExternal.get(b)
          if (!uuidA || !uuidB) continue
          const countA = importedFeatureCounts.get(a) ?? 0, countB = importedFeatureCounts.get(b) ?? 0
          const valid = pair.matches.filter(([ia, ib]) => ia < countA && ib < countB)
          invalid += pair.matches.length - valid.length
          if (valid.length) pairEntries.push({ uuidA, uuidB, matches: valid, F: pair.F, verified: pair.verified, rawCount: valid.length, source: 'colmap' })
        }
        if (invalid) log(`COLMAP import: skipped ${invalid} match(es) with invalid feature indices`, 'warn', 'Import')
        await matchesStore.importMatches(pairEntries, { replace: !!options.replaceMatches })
      }

      let sparseImported = 0
      if (session.genericModel && options.modelIds?.includes('model')) {
        if (importInteropModel(session.genericModel)) sparseImported++
      } else for (const model of session.models) {
        if (options.modelIds?.includes(model.externalId) && model.complete && importColmapModel(model.files)) sparseImported++
      }
      log(`SfM project imported: ${uuidByExternal.size} image name(s) matched${sparseImported ? `, ${sparseImported} sparse model(s)` : ''}`, 'success', 'Import')
      closeImport()
      if (sparseImported) activateTab('viewer')
    } catch (err) {
      session.status = 'ready'
      session.error = err?.message ?? String(err)
      log(`SfM project import failed: ${session.error}`, 'error', 'Import')
    }
  }

  return { importSession, openImport, closeImport, commitImport }
}
