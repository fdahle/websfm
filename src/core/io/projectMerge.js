// Import ▸ Project into this project: what of another project (B) joins this one (A).
// Pure, no Vue/Pinia/OPFS/DOM; the store (stores/projectMerge.js) carries the plan out.
//
// B's photos come in with their uuids (random, so they never collide with A's), and
// with them their features and the matches between them. A photo that is in both
// projects is not copied: it keeps A's record, features and matches, and B's matches
// on it are left out (they number B's keypoints of it, which do not come). A photo is
// the same when its source file name, file size, pixel size and capture time agree.
// A label (an image's name in the list) already taken in A gets a " (2)" suffix.
// B's sensors join A's when their calibration is identical, else come in as new
// sensors. GCPs and markers join A's of the same name, their image marks moved onto
// A's labels; imported camera positions follow their image.
//
// planProjectMerge({ target, source }) — each { images, sensors, gcps, poses } as the
// projects save them (project.json images, sensors.json, gcps.json, poses.json):
// → { shared: [{ source, target }], added: [{ image, name }], uuidOf (B uuid → A uuid,
//     or undefined for a shared photo's B-only data), nameOf (B label → A label),
//     sensors: { map: Map(B id → A id), add: [B sensor] }, gcps: [raw GCP with marks
//     on A labels], poses: [B imported pose on A labels], keepPair(idA, idB) }

const norm = (s) => String(s ?? '').toLowerCase()

// The fields that make two sensors the same camera calibration.
const SENSOR_FIELDS = [
  'width',
  'height',
  'focal',
  'focalUnit',
  'cx',
  'cy',
  'k1',
  'k2',
  'k3',
  'k4',
  'k5',
  'k6',
  'p1',
  'p2',
  'pixelSize',
  'sensorWidthMm',
  'distortionModel',
  'kind',
  'reseauStitched',
  'panoramicSegments',
]
export function sameCalibration(a, b) {
  for (const k of SENSOR_FIELDS) if ((a?.[k] ?? null) !== (b?.[k] ?? null)) return false
  return JSON.stringify(a?.fiducialCalibration ?? null) === JSON.stringify(b?.fiducialCalibration ?? null)
}

// The identity of a photo: the same file, wherever it was imported.
export function photoKey(img) {
  const m = img?.meta ?? {}
  return [norm(img?.sourceName ?? img?.name), m.fileSize ?? '', m.width ?? '', m.height ?? '', m.dateTime ?? ''].join(
    '|',
  )
}

// "DSC0001.JPG" → "DSC0001 (2).JPG", the first label not in `taken`.
export function freeLabel(name, taken) {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`
    if (!taken.has(next)) return next
  }
}

export function planProjectMerge({ target, source }) {
  const byKey = new Map()
  for (const img of target.images ?? []) if (!byKey.has(photoKey(img))) byKey.set(photoKey(img), img)
  const taken = new Set((target.images ?? []).map((img) => img.name))
  const takenUuid = new Set((target.images ?? []).map((img) => img.uuid))
  const shared = [],
    added = []
  const uuidOf = new Map(),
    nameOf = new Map()
  for (const img of source.images ?? []) {
    const same = byKey.get(photoKey(img))
    if (same) {
      shared.push({ source: img, target: same })
      nameOf.set(img.name, same.name)
      continue
    }
    // A uuid already in A means B was made from A (a copy): the photo is the same one.
    if (takenUuid.has(img.uuid)) {
      const t = target.images.find((x) => x.uuid === img.uuid)
      shared.push({ source: img, target: t })
      nameOf.set(img.name, t.name)
      continue
    }
    const name = freeLabel(img.name, taken)
    taken.add(name)
    added.push({ image: img, name })
    uuidOf.set(img.uuid, img.uuid)
    nameOf.set(img.name, name)
  }

  // Sensors: an identical calibration joins A's; anything else comes in as it is, under
  // a new id when A uses its id for another calibration (B was copied from A, then
  // recalibrated).
  const map = new Map(),
    add = []
  const used = new Set(added.map((a) => a.image.sensorId).filter(Boolean))
  const takenIds = new Set((target.sensors ?? []).map((t) => t.id))
  for (const s of source.sensors ?? []) {
    if (!used.has(s.id)) continue
    const same = (target.sensors ?? []).find((t) => sameCalibration(t, s))
    if (same) map.set(s.id, same.id)
    else {
      let id = s.id
      for (let n = 2; takenIds.has(id); n++) id = `${s.id}:${n}`
      takenIds.add(id)
      map.set(s.id, id)
      add.push(id === s.id ? s : { ...s, id })
    }
  }

  // GCPs and markers: marks on B's photos, on A's labels (addGcps joins them by name).
  // A name A already has keeps A's position: only B's marks come, without coordinates.
  const gcps = []
  const targetNames = new Set((target.gcps ?? []).map((g) => g.name))
  for (const g of source.gcps ?? []) {
    const observations = (g.observations ?? [])
      .filter((o) => nameOf.has(o.imageName))
      .map((o) => ({ ...o, imageName: nameOf.get(o.imageName), imageId: null }))
    const known = targetNames.has(g.name)
    if (!observations.length && (known || g.x == null || g.y == null)) continue
    gcps.push(known ? { ...g, x: null, y: null, z: null, observations } : { ...g, observations })
  }

  // Imported positions only: EXIF ones are derived again from the photos.
  const addedNames = new Set(added.map((a) => a.image.name))
  const poses = (source.poses ?? [])
    .filter((p) => p.source === 'imported' && addedNames.has(p.imageName))
    .map((p) => ({ ...p, imageName: nameOf.get(p.imageName), imageId: null }))

  const addedUuids = new Set(added.map((a) => a.image.uuid))
  return {
    shared,
    added,
    uuidOf,
    nameOf,
    sensors: { map, add },
    gcps,
    poses,
    // B's pair between two photos that come in (a shared photo keeps A's matches).
    keepPair: (idA, idB) => addedUuids.has(idA) && addedUuids.has(idB),
  }
}
