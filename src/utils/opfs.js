const FLOATS_PER_KP = 6 // x, y, nx, ny, scale, response

async function getRoot() {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle('websfm', { create: true })
}

async function readJson(dir, filename) {
  try {
    const fh = await dir.getFileHandle(filename)
    const file = await fh.getFile()
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}

async function writeJson(dir, filename, data) {
  const fh = await dir.getFileHandle(filename, { create: true })
  const writable = await fh.createWritable()
  await writable.write(JSON.stringify(data))
  await writable.close()
}

async function getProjectDir(projectId, create = false) {
  const root = await getRoot()
  const projects = await root.getDirectoryHandle('projects', { create: true })
  return projects.getDirectoryHandle(projectId, { create })
}

async function getSubDir(projectId, name) {
  const dir = await getProjectDir(projectId, true)
  return dir.getDirectoryHandle(name, { create: true })
}

// ── Availability ─────────────────────────────────────────────────────────────

export async function isAvailable() {
  try {
    await navigator.storage.getDirectory()
    return true
  } catch {
    return false
  }
}

export async function requestDurable() {
  return navigator.storage.persist()
}

export async function getQuota() {
  return navigator.storage.estimate()
}

// ── Index (project list) ──────────────────────────────────────────────────────

export async function readIndex() {
  const root = await getRoot()
  return readJson(root, 'index.json')
}

export async function writeIndex(data) {
  const root = await getRoot()
  await writeJson(root, 'index.json', data)
}

// ── Project ───────────────────────────────────────────────────────────────────

export async function readProject(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'project.json')
  } catch {
    return null
  }
}

export async function writeProject(projectId, data) {
  const dir = await getProjectDir(projectId, true)
  await writeJson(dir, 'project.json', data)
}

export async function deleteProject(projectId) {
  const root = await getRoot()
  const projects = await root.getDirectoryHandle('projects', { create: true })
  await projects.removeEntry(projectId, { recursive: true })
}

// ── Images ────────────────────────────────────────────────────────────────────

export async function saveImage(projectId, uuid, file) {
  const dir = await getSubDir(projectId, 'images')
  const fh = await dir.getFileHandle(uuid, { create: true })
  const writable = await fh.createWritable()
  await writable.write(file)
  await writable.close()
}

export async function loadImageBlob(projectId, uuid) {
  const dir = await getSubDir(projectId, 'images')
  const fh = await dir.getFileHandle(uuid)
  return fh.getFile()
}

export async function deleteImage(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'images')
    await dir.removeEntry(uuid)
  } catch {}
}

// ── Keypoints ─────────────────────────────────────────────────────────────────

export async function saveKeypoints(projectId, uuid, keypoints) {
  const buf = new Float32Array(keypoints.length * FLOATS_PER_KP)
  keypoints.forEach((kp, i) => {
    const o = i * FLOATS_PER_KP
    buf[o] = kp.x; buf[o + 1] = kp.y; buf[o + 2] = kp.nx
    buf[o + 3] = kp.ny; buf[o + 4] = kp.scale; buf[o + 5] = kp.response
  })
  const dir = await getSubDir(projectId, 'keypoints')
  const fh = await dir.getFileHandle(uuid + '.bin', { create: true })
  const writable = await fh.createWritable()
  await writable.write(buf.buffer)
  await writable.close()
}

export async function loadKeypoints(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'keypoints')
    const fh = await dir.getFileHandle(uuid + '.bin')
    const file = await fh.getFile()
    const buf = new Float32Array(await file.arrayBuffer())
    const n = buf.length / FLOATS_PER_KP
    const keypoints = []
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS_PER_KP
      keypoints.push({ x: buf[o], y: buf[o + 1], nx: buf[o + 2], ny: buf[o + 3], scale: buf[o + 4], response: buf[o + 5] })
    }
    return keypoints
  } catch {
    return null
  }
}

export async function deleteKeypoints(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'keypoints')
    await dir.removeEntry(uuid + '.bin')
  } catch {}
}

// ── Descriptors ───────────────────────────────────────────────────────────────
// Stored as raw Float32Array (N×128 floats) in descriptors/{uuid}.bin.
// Not loaded into the image object — fetched on-demand when matching.

export async function saveDescriptors(projectId, uuid, descriptors) {
  const dir = await getSubDir(projectId, 'descriptors')
  const fh = await dir.getFileHandle(uuid + '.bin', { create: true })
  const writable = await fh.createWritable()
  await writable.write(descriptors.buffer)
  await writable.close()
}

export async function loadDescriptors(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'descriptors')
    const fh = await dir.getFileHandle(uuid + '.bin')
    const file = await fh.getFile()
    return new Float32Array(await file.arrayBuffer())
  } catch {
    return null
  }
}

export async function deleteDescriptors(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'descriptors')
    await dir.removeEntry(uuid + '.bin')
  } catch {}
}

// ── Matches ───────────────────────────────────────────────────────────────────
// JSON: { idA, idB, rawCount, inlierCount, F, matches: [[ia,ib],...] }
// pairId = sorted([uuidA, uuidB]).join('--')

export async function saveMatches(projectId, pairId, data) {
  const dir = await getSubDir(projectId, 'matches')
  await writeJson(dir, pairId + '.json', data)
}

export async function loadMatches(projectId, pairId) {
  try {
    const dir = await getSubDir(projectId, 'matches')
    return readJson(dir, pairId + '.json')
  } catch {
    return null
  }
}

export async function deleteMatches(projectId, pairId) {
  try {
    const dir = await getSubDir(projectId, 'matches')
    await dir.removeEntry(pairId + '.json')
  } catch {}
}

export async function loadAllMatches(projectId) {
  try {
    const dir = await getSubDir(projectId, 'matches')
    const results = []
    for await (const [name, handle] of dir) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue
      try {
        const file = await handle.getFile()
        const data = JSON.parse(await file.text())
        results.push({ pairId: name.replace(/\.json$/, ''), ...data })
      } catch {}
    }
    return results
  } catch {
    return []
  }
}

export async function clearAllMatches(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    await dir.removeEntry('matches', { recursive: true })
  } catch {}
}

// ── Masks ─────────────────────────────────────────────────────────────────────

export async function saveMask(projectId, uuid, dataUrl) {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const dir = await getSubDir(projectId, 'masks')
  const fh = await dir.getFileHandle(uuid + '.png', { create: true })
  const writable = await fh.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function loadMaskDataUrl(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'masks')
    const fh = await dir.getFileHandle(uuid + '.png')
    const file = await fh.getFile()
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target.result)
      reader.readAsDataURL(file)
    })
  } catch {
    return null
  }
}

export async function deleteMask(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'masks')
    await dir.removeEntry(uuid + '.png')
  } catch {}
}

// ── Depth maps ────────────────────────────────────────────────────────────────

export async function saveDepth(projectId, uuid, dataUrl) {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const dir = await getSubDir(projectId, 'depthmaps')
  const fh = await dir.getFileHandle(uuid + '.png', { create: true })
  const writable = await fh.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function loadDepthDataUrl(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'depthmaps')
    const fh = await dir.getFileHandle(uuid + '.png')
    const file = await fh.getFile()
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target.result)
      reader.readAsDataURL(file)
    })
  } catch {
    return null
  }
}

export async function deleteDepth(projectId, uuid) {
  try {
    const dir = await getSubDir(projectId, 'depthmaps')
    await dir.removeEntry(uuid + '.png')
  } catch {}
}

// ── Ground Control Points ───────────────────────────────────────────────────────
// JSON: { crs, gcps: [{ id, name, x, y, z, observations: [...], enabled }] }

export async function saveGcps(projectId, data) {
  const dir = await getProjectDir(projectId, true)
  await writeJson(dir, 'gcps.json', data)
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
  try {
    const dir = await getProjectDir(projectId)
    await dir.removeEntry('gcps.json')
  } catch {}
}

// ── Footprints ──────────────────────────────────────────────────────────────────
// JSON: { crs, footprints: [{ id, name, imageId, imageName, rings, enabled }] }

export async function saveFootprints(projectId, data) {
  const dir = await getProjectDir(projectId, true)
  await writeJson(dir, 'footprints.json', data)
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
  try {
    const dir = await getProjectDir(projectId)
    await dir.removeEntry('footprints.json')
  } catch {}
}

// ── Sensors (shared camera intrinsics) ──────────────────────────────────────────
// JSON: { sensors: [{ id, label, width, height, pixelSize, focal, cx, cy,
//                      k1, k2, k3, p1, p2, fixed, source }] }
// Intrinsics are CRS-free, so (unlike GCPs/footprints/poses) no `crs` field.

export async function saveSensors(projectId, data) {
  const dir = await getProjectDir(projectId, true)
  await writeJson(dir, 'sensors.json', data)
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
  try {
    const dir = await getProjectDir(projectId)
    await dir.removeEntry('sensors.json')
  } catch {}
}

// ── Camera poses (exterior orientation / extrinsics) ────────────────────────────
// JSON: { crs, poses: [{ imageId, imageName, x, y, z, omega, phi, kappa,
//                        accXYZ, accAngle, source, enabled }] }
// Positions live in the project CRS; angles (deg) pass through unchanged.

export async function savePoses(projectId, data) {
  const dir = await getProjectDir(projectId, true)
  await writeJson(dir, 'poses.json', data)
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
  try {
    const dir = await getProjectDir(projectId)
    await dir.removeEntry('poses.json')
  } catch {}
}

// ── Reconstruction ────────────────────────────────────────────────────────────
// JSON: { cameras: [{ uuid, R, t, K }], points: [{ x, y, z }] }

export async function saveReconstruction(projectId, data) {
  const dir = await getProjectDir(projectId, true)
  await writeJson(dir, 'reconstruction.json', data)
}

export async function loadReconstruction(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    return readJson(dir, 'reconstruction.json')
  } catch {
    return null
  }
}

export async function deleteReconstruction(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    await dir.removeEntry('reconstruction.json')
  } catch {}
}
