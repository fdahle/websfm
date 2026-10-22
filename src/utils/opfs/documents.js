// The small per-project JSON documents: control points, shapefiles, scale bars,
// measurements, workflows, sensors and camera poses.
import { trackPersistence, ignoreMissing } from '../persistence.js'
import { getProjectDir, readJson, writeJson } from './base.js'

// ── Ground Control Points ───────────────────────────────────────────────────────
// JSON: { crs, importDefaults, gcps: [{ coordinates, covariance metadata,
// observations with pixel sigmas, role, enabled }] }

export async function saveGcps(projectId, data) {
  return trackPersistence('saveGcps:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'gcps.json', data)
  })
}

export async function loadGcps(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'gcps.json')
  } catch {
    return null
  }
}

export async function deleteGcps(projectId) {
  return trackPersistence('deleteGcps:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('gcps.json')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Vector sets (image footprints, contour lines, polygon files) ───────────────────
// JSON: { crs, sets: [{ id, name, source, kind?, visible, opacity?,
//         footprints: [{ id, imageId, imageName, rings }] }] }

export async function saveFootprints(projectId, data) {
  return trackPersistence('saveFootprints:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'footprints.json', data)
  })
}

export async function loadFootprints(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'footprints.json')
  } catch {
    return null
  }
}

export async function deleteFootprints(projectId) {
  return trackPersistence('deleteFootprints:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('footprints.json')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Scale bars (known-distance constraints) ──────────────────────────────────────
// JSON: { bars: [{ id, name, a:{kind,id}, b:{kind,id}, knownDistanceM, accuracyM,
//                  displayUnit, enabled }] }
// This is *evidence* — what the user measured — and is deliberately separate from
// the derived fit, which lives in reconstruction.json as `scaleFit`. A scale is a
// cached result of (model × bars × marks); keeping the two apart is what lets the
// fit go stale without the measurements going with it.
// No `crs` field: a bar's distance is metres, which is CRS-independent — and a
// scale-bar project characteristically has no CRS at all.

export async function saveScaleBars(projectId, data) {
  return trackPersistence('saveScaleBars:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'scalebars.json', data)
  })
}

export async function loadScaleBars(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'scalebars.json')
  } catch {
    return null
  }
}

export async function deleteScaleBars(projectId) {
  return trackPersistence('deleteScaleBars:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('scalebars.json')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

export async function saveMeasurements(projectId, data) {
  return trackPersistence('saveMeasurements:' + String(projectId), async () => {
    await writeJson(await getProjectDir(projectId, true), 'measurements.json', data)
  })
}
export async function loadMeasurements(projectId) {
  try {
    return await readJson(await getProjectDir(projectId), 'measurements.json')
  } catch {
    return null
  }
}
export async function deleteMeasurements(projectId) {
  return trackPersistence('deleteMeasurements:' + String(projectId), async () => {
    try {
      await (await getProjectDir(projectId)).removeEntry('measurements.json')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Workflow builder ──────────────────────────────────────────────────────────
// JSON: { workflows: Workflow[], activeId, runs: immutable execution snapshots[] }

export async function saveWorkflows(projectId, data) {
  return trackPersistence('saveWorkflows:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'workflows.json', data)
  })
}

export async function loadWorkflows(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'workflows.json')
  } catch {
    return null
  }
}

export async function deleteWorkflows(projectId) {
  return trackPersistence('deleteWorkflows:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('workflows.json')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Sensors (shared camera intrinsics) ──────────────────────────────────────────
// JSON: { sensors: [{ id, label, width, height, pixelSize, focal, cx, cy,
//                      k1, k2, k3, p1, p2, fixed, source }] }
// Intrinsics are CRS-free, so (unlike GCPs/footprints/poses) no `crs` field.

export async function saveSensors(projectId, data) {
  return trackPersistence('saveSensors:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'sensors.json', data)
  })
}

export async function loadSensors(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'sensors.json')
  } catch {
    return null
  }
}

export async function deleteSensors(projectId) {
  return trackPersistence('deleteSensors:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('sensors.json')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Camera poses (exterior orientation / extrinsics) ────────────────────────────
// JSON: { crs, poses: [{ imageId, imageName, x, y, z, omega, phi, kappa,
//                        accuracyX/Y/Z, accXYZ, accuracyOmega/Phi/Kappa,
//                        accAngle, source, enabled }] }
// Positions live in the project CRS; angles (deg) pass through CRS changes
// unchanged and are consumed as camera-orientation priors during BA.

export async function savePoses(projectId, data) {
  return trackPersistence('savePoses:' + String(projectId), async () => {
    const dir = await getProjectDir(projectId, true)
    await writeJson(dir, 'poses.json', data)
  })
}

export async function loadPoses(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'poses.json')
  } catch {
    return null
  }
}

export async function deletePoses(projectId) {
  return trackPersistence('deletePoses:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('poses.json')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}
