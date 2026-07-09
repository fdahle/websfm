import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useModalsStore } from '../stores/useModalsStore.js'
import { parseGeoJson, looksLikeGeoJson, geoJsonToGcps, guessNameKey } from '../core/io/geojson.js'
import { detectCameraMode } from '../core/io/cameraKind.js'
import { detectFileKind } from '../core/io/importKind.js'
import { parseFiducialObs } from '../core/io/fiducialObs.js'

// The dropped/picked-file import funnel, lifted out of App.vue. It drives the
// import-related modals (all state lives in useModalsStore, pulled in here) and
// commits parsed data through the injected store actions. Injected deps:
//   addGcps, addFootprints, addSensors, addPoses — store actions
//   activateTab(id) — switch the active tab (to 'map' after a spatial import)
// `cameraPickMode` is returned so the Ribbon command dispatch (still in App.vue)
// can hint the file-picker mode before opening the hidden <input>.
export function useImportRouting({ addGcps, addFootprints, addSensors, addPoses, addFiducialObs, activateTab }) {
  const {
    gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
    footprintImportOpen, footprintImportData,
    cameraImportOpen, cameraImportText, cameraImportName, cameraImportMode,
    importKindOpen, importKindFile,
  } = storeToRefs(useModalsStore())

  // sensor | pose | null, set before opening the file picker (by the command dispatch).
  const cameraPickMode = ref(null)

  // ── Import (GCPs / footprints) ──────────────────────────────────────────────────
  // A delimited text file is always GCPs. A GeoJSON file is routed by geometry:
  // point features → GCP import, polygon features → footprint import.
  async function openImportFile(file) {
    if (!file) return
    let text
    try {
      text = await file.text()
    } catch (err) {
      console.error('Could not read import file', err)
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
    let text
    try {
      text = await file.text()
    } catch (err) {
      console.error('Could not read dropped file', err)
      return
    }
    routeImport(file, detectFileKind(text, file.name).kind)
  }

  function routeImport(file, kind) {
    if (kind === 'pose' || kind === 'sensor') openCameraImport(file, kind)
    else if (kind === 'gcp' || kind === 'footprint') openImportFile(file)
    else if (kind === 'fiducialObs') openFiducialObsImport(file)
    else { importKindFile.value = file; importKindOpen.value = true }
  }

  // Fiducial-mark pixel observations (F4) commit directly — a row is (image,
  // fiducial, px, py) matched to an image by name, no CRS or column ambiguity
  // that would need a modal.
  async function openFiducialObsImport(file) {
    if (!file || !addFiducialObs) return
    let text
    try { text = await file.text() } catch (err) { console.error('Could not read fiducial file', err); return }
    const { rows } = parseFiducialObs(text)
    addFiducialObs(rows)
  }

  // User answered the "what is this file?" chooser.
  function onImportKindChosen(kind) {
    const file = importKindFile.value
    importKindOpen.value = false
    importKindFile.value = null
    if (file) routeImport(file, kind)
  }

  // User re-classified the file from inside an open import modal ("Import as …").
  function onImportSwitchKind({ kind, rawText, fileName }) {
    gcpImportOpen.value = false
    cameraImportOpen.value = false
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

  async function onGcpImport({ gcps: parsed, sourceCrs }) {
    gcpImportOpen.value = false
    gcpImportGeojson.value = null
    await addGcps(parsed, sourceCrs)
    activateTab('map')
  }

  async function onFootprintImport({ footprints: parsed, sourceCrs }) {
    footprintImportOpen.value = false
    footprintImportData.value = null
    await addFootprints(parsed, sourceCrs)
    activateTab('map')
  }

  function onGcpPick(event) {
    const file = event.target.files?.[0]
    if (file) openImportFile(file)
    event.target.value = ''
  }

  // ── Import (camera intrinsics / extrinsics) ──────────────────────────────────────
  // A delimited camera file opens the import modal in the sniffed mode (sensor vs
  // pose); `forceMode` lets the Ribbon's two commands hint a default.
  async function openCameraImport(file, forceMode = null) {
    if (!file) return
    let text
    try {
      text = await file.text()
    } catch (err) {
      console.error('Could not read camera file', err)
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
      await addSensors(payload.sensors)
    } else {
      await addPoses(payload.poses, payload.sourceCrs)
      activateTab('map')
    }
  }

  function onCameraPick(event) {
    const file = event.target.files?.[0]
    if (file) openCameraImport(file, cameraPickMode.value)
    event.target.value = ''
  }

  return {
    cameraPickMode,
    openImportFile, openDroppedImport, routeImport, openFiducialObsImport,
    onImportKindChosen, onImportSwitchKind,
    openCameraImport, onCameraImport, onGcpImport, onFootprintImport,
    onGcpPick, onCameraPick,
  }
}
