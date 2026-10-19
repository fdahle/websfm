import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useModalsStore } from '../stores/useModalsStore.js'
import { parseGeoJson, looksLikeGeoJson, geoJsonToGcps, guessNameKey } from '../core/io/geojson.js'
import { detectCameraMode } from '../core/io/cameraKind.js'
import { detectFileKind, isColmapFile } from '../core/io/importKind.js'
import { parseFiducialObs } from '../core/io/fiducialObs.js'
import { parseFiducialMarks } from '../core/io/fiducialMarks.js'
import { sniffCloudFormat, looksLikeXyzText } from '../core/io/cloudImport.js'
import { looksLikeZipHead, isProjectArchiveName } from '../core/io/projectArchive.js'
import { applyImportTransform } from '../core/io/cloudImport.js'
import { parseCloudFile as parseCloudFileWorker, terminateAll } from '../workers/computeClient.js'
import { lasNeedsStreaming } from '../core/io/lasStream.js'
import { copcReadsInPlace, COPC_IN_PLACE_MIN_POINTS } from '../core/lod/copc.js'
import { unzipStore } from '../utils/zip.js'
import { peekArchiveManifest } from '../utils/projectFile.js'
import { isTiff, isGeoreferencedTiff, probeTiffGeoTags } from '../utils/tiff.js'
import { isVideoFile } from '../core/io/videoFrames.js'
import { extractVideoFrames } from '../utils/videoSource.js'
import { useLog } from './useLog.js'
import { showToast } from './useToasts.js'

// The dropped/picked-file import funnel, lifted out of App.vue. It drives the
// import-related modals (all state lives in useModalsStore, pulled in here) and
// commits parsed data through the injected store actions. Injected deps:
//   addGcps, addFootprints, importSensors, addPoses — store actions
//   activateTab(id) — switch the active tab (to 'map' after a spatial import)
// `cameraPickMode` is returned so the Ribbon command dispatch (still in App.vue)
// can hint the file-picker mode before opening the hidden <input>.
export function useImportRouting({ addGcps, addFootprints, importSensors, addPoses, addFiducialObs, addFiducialMarks, importColmap, openSfmProject, importCloud, importStreamedCloud = null, importCopcCloud = null, progress = null, importRaster, importProjectFile, addImages, activateTab, showGcps, showSensors, showPoses }) {
  const {
    gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
    footprintImportOpen, footprintImportData,
    cameraImportOpen, cameraImportText, cameraImportName, cameraImportMode,
    importKindDeclared, importKindOpen, importKindFile, fiducialImportData,
    importCloudOpen, importCloudData,
    importRasterOpen, importRasterData, importVideoFile,
  } = storeToRefs(useModalsStore())
  const { log } = useLog()

  // A file that cannot even be read: log it and tell the user, the same way every
  // other failed import does — the console alone is invisible to them.
  function readFailed(what, file, err) {
    const detail = `${file?.name ? `${file.name}: ` : ''}${err?.message ?? err}`
    log(`Could not read ${what} — ${detail}`, 'error', 'Import')
    showToast(`Could not read ${what}`, { detail, kind: 'error', ms: 6000 })
  }

  // Text files past this size are routed by their head (see openDroppedImport).
  const LARGE_TEXT_BYTES = 64 * 1024 * 1024

  // sensor | pose | null, set before opening the file picker (by the command dispatch).
  const cameraPickMode = ref(null)

  // ── Import (GCPs / footprints) ──────────────────────────────────────────────────
  // A delimited text file is always GCPs. A GeoJSON file is routed by geometry:
  // point features → GCP import, polygon features → footprint import.
  // `declared` = the user already said this is a GCP file (a Ribbon command or
  // the kind chooser), so the modal shows a correction link instead of asking.
  async function openImportFile(file, { declared = false } = {}) {
    if (!file) return
    importKindDeclared.value = declared
    let text
    try {
      text = await file.text()
    } catch (err) {
      readFailed('the import file', file, err)
      return
    }

    if (looksLikeGeoJson(file.name, text)) {
      const parsed = parseGeoJson(text)
      if (parsed.kind === 'polygons' || parsed.kind === 'mixed') {
        footprintImportData.value = {
          features: parsed.features,
          propertyKeys: parsed.propertyKeys,
          detectedCrs: parsed.sourceCrs,
          fileName: file.name,
        }
        footprintImportOpen.value = true
      }
      if (parsed.kind === 'points' || parsed.kind === 'mixed') {
        const nameKey = guessNameKey(parsed.propertyKeys)
        gcpImportGeojson.value = geoJsonToGcps(parsed.features, nameKey)
        gcpImportCrs.value = parsed.sourceCrs
        gcpImportName.value = file.name
        gcpImportOpen.value = true
      }
      return
    }

    // Delimited-text GCP file.
    gcpImportGeojson.value = null
    gcpImportCrs.value = null
    gcpImportText.value = text
    gcpImportName.value = file.name
    gcpImportOpen.value = true
  }

  // Sidebar drag-and-drop has no declared intent, so classify the dropped file and
  // route it: GCPs/footprints → GCP importer, poses/intrinsics → camera importer,
  // and anything ambiguous (a bare name + X/Y/Z list) → a small chooser.
  async function openDroppedImport(file) {
    if (!file) return
    // A video becomes images (Import ▸ Video's frame selection), never text or a cloud.
    if (isVideoFile(file)) { openVideoImport(file); return }
    // A `.websfm` project file is a whole *project*, not data to merge into the
    // open one, so it is checked first and short-circuits every other route. The
    // gate is magic bytes + a manifest peek, never the extension alone: a COLMAP
    // model also arrives as a `.zip`, and the manifest is what tells them apart.
    if (importProjectFile && await isProjectArchive(file)) { await importProjectFile(file); return }
    // A TIFF that reached the non-image path (no `image/tiff` MIME type, e.g. a
    // bare `.tif` from some file managers) still has to be checked for geokeys
    // before anything tries to decode it as text.
    if (importRaster && isTiff(file)) {
      if (await isGeoreferencedTiff(file)) { await openRasterImport(file); return }
      if (addImages) { addImages([file]); return } // a plain TIFF is a source photo
    }
    // Binary cloud formats (PLY/LAS) must be sniffed by magic bytes BEFORE any
    // text decode — decoding a 500 MB LAS as a string would blow up. Peek the head.
    try {
      const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
      const fmt = sniffCloudFormat(head, file.name)
      if (fmt === 'ply' || fmt === 'las') { openCloudImport(file); return }
    } catch { /* fall through to text routing */ }
    // A large text file is sniffed from its head alone: a multi-GB .xyz must reach
    // the streaming cloud reader without ever becoming one string here. GCP / pose /
    // GeoJSON files are small, so everything else keeps the whole-text detection.
    if (file.size > LARGE_TEXT_BYTES && !isColmapFile(file.name)) {
      try {
        if (looksLikeXyzText(await headText(file))) { openCloudImport(file); return }
      } catch { /* fall through */ }
    }

    let text
    try {
      text = await file.text()
    } catch (err) {
      readFailed('the dropped file', file, err)
      return
    }
    routeImport(file, detectFileKind(text, file.name).kind)
  }

  // The first ~1 MiB as text, cut at the last complete line.
  async function headText(file) {
    const text = new TextDecoder().decode(await file.slice(0, 1024 * 1024).arrayBuffer())
    const nl = text.lastIndexOf('\n')
    return nl > 0 ? text.slice(0, nl) : text
  }

  // Cheap two-step: ZIP magic (4 bytes) then, only for a zip, the manifest peek
  // (a few kB). Never text-decodes, never reads the whole file.
  async function isProjectArchive(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
      if (!looksLikeZipHead(head)) return false
      if (isProjectArchiveName(file.name)) return true
      const manifest = await peekArchiveManifest(file)
      return !!manifest
    } catch {
      return false
    }
  }

  function routeImport(file, kind, { declared = false } = {}) {
    if (kind === 'pose' || kind === 'sensor') openCameraImport(file, kind, { declared })
    else if (kind === 'gcp' || kind === 'footprint') openImportFile(file, { declared })
    else if (kind === 'fiducialObs') openFiducialObsImport(file)
    else if (kind === 'fiducialMarks') openFiducialMarksImport(file)
    else if (kind === 'colmap') openColmapImport([file])
    else if (kind === 'cloud') openCloudImport(file)
    else { importKindFile.value = file; importKindOpen.value = true }
  }

  // ── Import (georeferenced reference raster) ─────────────────────────────────
  //
  // ⚠ The routing conflict this solves: `useImagesStore` ingests ANY TIFF as a
  // source image, and a dropped `.tif` arrives with type `image/tiff`, so it
  // lands in the image path before any importer sees it. Every dropped/picked
  // image batch therefore gets forked here FIRST: a TIFF carrying GeoTIFF
  // geolocation tags is a reference raster, not a source photo. Aerial scans
  // carry no geokeys, so the split is clean in practice — and when it isn't, the
  // import modal offers "…or import as source image" as the escape hatch.
  //
  // Returns the files that really are source images, for the caller to ingest.
  async function forkGeoreferencedRasters(files) {
    const photos = []
    for (const file of [...(files || [])]) {
      if (importRaster && isTiff(file)) {
        const probe = await probeTiffGeoTags(file)
        if (probe.georeferenced) {
          await openRasterImport(file)
          continue
        }
        // Not georeferenced ⇒ source photo. Say so, with the tags that were
        // missing: this is the branch that surprises people (a GeoTIFF written
        // without a pixel scale, or one geotiff.js can't parse, becomes a very
        // confused source image), and the sidebar's "Convert to reference
        // data…" is the manual override for exactly this line.
        log(`${file.name}: ${probe.degenerate
          ? 'placeholder GeoTIFF tags (identity transform at origin 0,0, no CRS) — not georeferencing'
          : 'no GeoTIFF geolocation tags'}`
          + `${probe.error ? ` (header unreadable: ${probe.error})` : ''}`
          + ` [tiepoint ${probe.hasTiepoint ? 'yes' : 'no'},`
          + ` pixelscale ${probe.hasPixelScale ? 'yes' : 'no'},`
          + ` transformation ${probe.hasTransformation ? 'yes' : 'no'},`
          + ` crs ${probe.hasCrs ? 'yes' : 'no'}]`
          + ' — ingesting as a source image', 'info', 'Import')
      }
      photos.push(file)
    }
    return photos
  }

  // Dropped/picked image batch: fork the reference rasters out, ingest the rest.
  async function addImagesRouted(files) {
    const photos = await forkGeoreferencedRasters(files)
    if (photos.length && addImages) await addImages(photos)
  }

  // Decode + classify off-thread, then either commit straight away (the sniff
  // was decisive) or open the modal pre-selected to the guess.
  //
  // Confidence gating differs deliberately from `importKind.js`, which always
  // routes ambiguity to a modal: here a `high` verdict imports directly and
  // logs its reasons. That is only safe because the kind stays editable
  // afterwards ("Treat as DEM / orthophoto" on the Reference Data row) — without
  // that escape hatch a silent misclassification would be a delete-and-reimport.
  //
  // `alwaysConfirm` overrides that gating for the manual "Convert to reference
  // data…" path: the auto-sniff already declined that file once, so its verdict
  // has not earned a silent import however confident it sounds.
  //
  // Returns the raster record (null if the parse failed), so a caller that is
  // *moving* a file into reference data can tell whether the move succeeded
  // before deleting the source.
  async function openRasterImport(file, { forceKind = null, alwaysConfirm = false } = {}) {
    if (!file || !importRaster) return null
    const record = await importRaster(file, { forceKind })
    if (!record) return null

    if (alwaysConfirm || (!forceKind && record.classification?.confidence === 'low')) {
      // Ambiguous (a 1-band int16/uint16 resolved only by histogram, or by
      // filename alone) — show the user what it guessed and why, and let them
      // correct it before they build anything on top of it.
      importRasterData.value = { raster: record, fileName: file.name }
      importRasterOpen.value = true
    }
    activateTab('map')
    return record
  }

  function onRasterPick(event) {
    const file = event.target.files?.[0]
    if (file) openRasterImport(file)
    event.target.value = ''
  }

  // ── Import (video → frames as images) ───────────────────────────────────────
  // The dialog (ImportVideoModal) opens the video, scans it in the automatic mode and
  // plans the frame times; Extract lands here. Frames are encoded one at a time and
  // written to the project in small batches (utils/videoSource.js), so a long video
  // never holds its frames in memory.
  function openVideoImport(file) {
    if (!file || !addImages) return
    importVideoFile.value = file
  }

  function onVideoPick(event) {
    openVideoImport(event.target.files?.[0])
    event.target.value = ''
  }

  async function onVideoImport({ file, times, duration, fps, settings }) {
    importVideoFile.value = null
    if (!file || !times?.length || !addImages) return
    const how = settings.mode === 'auto'
      ? `automatic: ${settings.overlap} % overlap, at most ${settings.maxFrames}, blurry below ${settings.minSharpness} × nearby median`
      : `every ${settings.every} ${settings.unit}${settings.unit === 'frames' ? ` at ${fps ?? '30 (assumed)'} fps` : ''}`
    log(`Video import: ${file.name} — extracting ${times.length} frame(s) (${how}) as `
      + `${settings.format === 'png' ? 'PNG' : `JPEG q${settings.jpegQuality}`}`
      + `${settings.maxDim > 0 ? `, long side ≤ ${settings.maxDim} px` : ', full size'}`, 'info', 'Import')
    progress?.open('Extracting video frames', times.length, null, { unit: 'frames' })
    let result = null
    try {
      result = await extractVideoFrames({
        file, times, duration, fps, settings, addImages,
        onProgress: (done, total, name) => progress?.report(done, total, name),
        shouldCancel: () => !!progress?.aborted?.value,
      })
    } catch (err) {
      readFailed('the video', file, err)
    } finally {
      await progress?.close()
    }
    if (!result) return
    log(`Video import: ${result.added} of ${times.length} frame(s) from ${file.name} added`
      + `${result.cancelled ? ' (cancelled)' : ''}`, result.cancelled ? 'warn' : 'success', 'Import')
    if (result.added) {
      showToast(`Added ${result.added} frame${result.added === 1 ? '' : 's'} from ${file.name}`, {
        detail: 'Match Features starts on Sequential pairing for video frames.',
      })
    }
  }

  // ── Import (point cloud / mesh) ─────────────────────────────────────────────
  // Parse the file off the main thread (the parseCloud worker op), then open the
  // settings modal with the parsed cloud + stats. The File goes to the worker as a
  // handle and is read there in slices (text formats stream), so this thread never
  // holds its bytes; the parsed buffers are transferred back.
  async function openCloudImport(file) {
    if (!file || !importCloud) return
    // A LAS/LAZ too large to hold in memory is streamed into a level-of-detail octree
    // instead (core/io/lasStream.js); the dialog's transforms need resident points.
    // A large COPC file is an octree already: read in place, never decoded whole.
    const route = (importStreamedCloud || importCopcCloud) ? await lasRoute(file) : null
    const importer = route === 'copc' ? importCopcCloud : route === 'stream' ? importStreamedCloud : null
    if (importer) {
      progress?.open('Importing point cloud', 100, () => terminateAll('import cancelled'))
      const cloud = await importer(file, progress?.report)
      await progress?.close()
      if (cloud) activateTab('viewer')
      return
    }
    try {
      const { parsed, stats } = await parseCloudFileWorker(file, {
        onLog: (m, l, c) => log(m, l, c),
      })
      importCloudData.value = { parsed, stats, fileName: file.name }
      importCloudOpen.value = true
    } catch (err) {
      log(`Cloud import: ${err?.message ?? err}`, 'error', 'Import')
    }
  }

  // 'copc' (read in place), 'stream' (into an octree) or null (into memory).
  async function lasRoute(file) {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer())
    if (head.length < 100 || String.fromCharCode(head[0], head[1], head[2], head[3]) !== 'LASF') return null
    const offsetToPoints = new DataView(head.buffer).getUint32(96, true)
    const full = offsetToPoints > head.length
      ? new Uint8Array(await file.slice(0, Math.min(file.size, offsetToPoints)).arrayBuffer()) : head
    const stream = lasNeedsStreaming(full, file.size) === true
    if (importCopcCloud && copcReadsInPlace(full, { minPoints: stream ? 0 : COPC_IN_PLACE_MIN_POINTS })) return 'copc'
    return stream && importStreamedCloud ? 'stream' : null
  }

  // User confirmed the cloud-import settings: apply the transform + commit.
  function onCloudImport(settings) {
    const data = importCloudData.value
    importCloudOpen.value = false
    importCloudData.value = null
    if (!data) return
    const transformed = applyImportTransform(data.parsed, { ...settings, onLog: (m, l, c) => log(m, l, c) })
    if (importCloud(transformed, data.fileName)) activateTab('viewer')
  }

  function onCloudPick(event) {
    const file = event.target.files?.[0]
    if (file) openCloudImport(file)
    event.target.value = ''
  }

  // COLMAP sparse model — a file *set*, so accept either a `.zip` or the loose
  // `cameras.{txt,bin}` / `images.{txt,bin}` / `points3D.{txt,bin}`
  // (case-insensitive, path-stripped). Text entries carry strings, binary entries
  // carry Uint8Array — the store's importColmapModel picks the parser by key
  // suffix. A model must not mix text + binary of the same table; the binary
  // variant wins when both appear (unlikely; a defensive tie-break).
  const COLMAP_CANON = {
    'cameras.txt': 'cameras.txt', 'images.txt': 'images.txt', 'points3d.txt': 'points3D.txt',
    'cameras.bin': 'cameras.bin', 'images.bin': 'images.bin', 'points3d.bin': 'points3D.bin',
  }
  async function openColmapImport(fileList) {
    const files = [...(fileList || [])]
    if (openSfmProject) { await openSfmProject(files); return }
    if (!files.length || !importColmap) return
    const model = {}
    try {
      const zip = files.find((f) => /\.zip$/i.test(f.name))
      // Every entry stays bytes: parseColmapModel decodes a .txt a slice at a time,
      // so a large images.txt never becomes one string.
      const add = (name, data) => {
        const key = COLMAP_CANON[String(name).split(/[\\/]/).pop().toLowerCase()]
        if (!key) return
        model[key] = typeof data === 'string' ? data : new Uint8Array(data)
      }
      if (zip) {
        for (const e of unzipStore(new Uint8Array(await zip.arrayBuffer()))) add(e.name, e.data)
      } else {
        for (const f of files) if (isColmapFile(f.name)) add(f.name, await f.arrayBuffer())
      }
    } catch (err) {
      readFailed('the COLMAP model', null, err)
      return
    }
    if (importColmap(model)) activateTab('viewer')
  }

  // Fiducial-mark pixel observations (F4) commit directly — a row is (image,
  // fiducial, px, py) matched to an image by name, no CRS or column ambiguity
  // that would need a modal.
  async function openFiducialObsImport(file) {
    if (!file || !addFiducialObs) return
    let text
    try { text = await file.text() } catch (err) { readFailed('the fiducial file', file, err); return }
    const { rows, layout } = parseFiducialObs(text)
    if (!rows.length) { log(`Image fiducials: no marks with finite pixel positions in ${file.name}`, 'warn', 'Sensor'); return }
    fiducialImportData.value = { kind: 'image', fileName: file.name, rows, layout }
  }

  // Camera fiducial marks (a film camera's certificate, mm): rows group by sensor
  // label; the preview proposes a sensor per group (planFiducialMarkTargets).
  async function openFiducialMarksImport(file) {
    if (!file || !addFiducialMarks) return
    let text
    try { text = await file.text() } catch (err) { readFailed('the fiducial file', file, err); return }
    const { groups } = parseFiducialMarks(text)
    if (!groups.length) { log('Camera fiducials: no marks with finite x_mm / y_mm found', 'warn', 'Sensor'); return }
    fiducialImportData.value = { kind: 'camera', fileName: file.name, groups }
  }

  // The fiducial preview's Import: apply what it showed.
  function onFiducialImport(payload) {
    fiducialImportData.value = null
    if (payload.kind === 'image') addFiducialObs(payload.rows)
    else if (addFiducialMarks(payload.groups, payload.targetIds)) showSensors?.()
  }

  // User answered the "what is this file?" chooser.
  function onImportKindChosen(kind) {
    const file = importKindFile.value
    importKindOpen.value = false
    importKindFile.value = null
    if (file) routeImport(file, kind, { declared: true })
  }

  // User re-classified the file from inside an open import modal ("Import as …").
  function onImportSwitchKind({ kind, rawText, fileName }) {
    gcpImportOpen.value = false
    cameraImportOpen.value = false
    importKindDeclared.value = true   // the correction itself is a declaration
    if (kind === 'gcp') {
      gcpImportGeojson.value = null
      gcpImportCrs.value = null
      gcpImportText.value = rawText
      gcpImportName.value = fileName
      gcpImportOpen.value = true
    } else {
      cameraImportText.value = rawText
      cameraImportName.value = fileName
      cameraImportMode.value = kind // 'pose' | 'sensor'
      cameraImportOpen.value = true
    }
  }

  async function onGcpImport({ gcps: parsed, sourceCrs, defaultAccuracies, accuracySettings, defaultImageAccuracies }) {
    gcpImportOpen.value = false
    gcpImportGeojson.value = null
    await addGcps(parsed, sourceCrs, defaultAccuracies, accuracySettings, defaultImageAccuracies)
    activateTab('map')
    showGcps?.()
  }

  async function onFootprintImport({ footprints: parsed, sourceCrs, name }) {
    footprintImportOpen.value = false
    footprintImportData.value = null
    // Name the imported set after the file (strip extension) so the sidebar row
    // is recognisable; the store falls back to a generic label if absent.
    const setName = name ? name.replace(/\.[^.]+$/, '') : undefined
    await addFootprints(parsed, sourceCrs, setName)
    activateTab('map')
  }

  function onGcpPick(event) {
    const file = event.target.files?.[0]
    if (file) openImportFile(file, { declared: true })   // Ribbon ▸ Import ▸ GCP File
    event.target.value = ''
  }

  // ── Import (camera intrinsics / extrinsics) ──────────────────────────────────────
  // A delimited camera file opens the import modal in the sniffed mode (sensor vs
  // pose); `forceMode` lets the Ribbon's two commands hint a default.
  async function openCameraImport(file, forceMode = null, { declared = false } = {}) {
    if (!file) return
    importKindDeclared.value = declared
    let text
    try {
      text = await file.text()
    } catch (err) {
      readFailed('the camera file', file, err)
      return
    }
    cameraImportText.value = text
    cameraImportName.value = file.name
    cameraImportMode.value = forceMode || detectCameraMode(text)
    cameraImportOpen.value = true
  }

  async function onCameraImport(payload) {
    cameraImportOpen.value = false
    if (payload.mode === 'sensor') {
      await importSensors(payload.items)
      showSensors?.()
    } else {
      await addPoses(payload.poses, payload.sourceCrs)
      activateTab('map')
      showPoses?.()
    }
  }

  function onCameraPick(event) {
    const file = event.target.files?.[0]
    // The Ribbon's two camera commands set `cameraPickMode` before opening the
    // picker — that IS the declaration; a mode-less pick is still a sniff.
    if (file) openCameraImport(file, cameraPickMode.value, { declared: !!cameraPickMode.value })
    event.target.value = ''
  }

  // Ribbon ▸ Import ▸ Image / Camera Fiducials: the command is the declaration.
  function onFiducialObsPick(event) {
    openFiducialObsImport(event.target.files?.[0])
    event.target.value = ''
  }

  function onFiducialMarksPick(event) {
    openFiducialMarksImport(event.target.files?.[0])
    event.target.value = ''
  }

  function onColmapPick(event) {
    openColmapImport(event.target.files)
    event.target.value = ''
  }

  return {
    cameraPickMode,
    openImportFile, openDroppedImport, routeImport, isProjectArchive,
    openFiducialObsImport, openFiducialMarksImport, openColmapImport,
    openCloudImport, onCloudImport, onCloudPick,
    openRasterImport, onRasterPick, forkGeoreferencedRasters, addImagesRouted,
    openVideoImport, onVideoPick, onVideoImport,
    onImportKindChosen, onImportSwitchKind,
    openCameraImport, onCameraImport, onGcpImport, onFootprintImport, onFiducialImport,
    onGcpPick, onCameraPick, onColmapPick, onFiducialObsPick, onFiducialMarksPick,
  }
}
