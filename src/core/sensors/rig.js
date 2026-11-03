// Multispectral camera rigs (plan-after-0.7 ▸ MSP-1/2). A rig is one shutter and
// several lenses: each capture is one moment with one image per band, and every band's
// lens sits at a fixed offset from the reference band's. The bands are read from the
// image metadata (core/io/metadata.js bandMetadata), so nothing about a rig is stored:
// it is found again from the photos whenever a run needs it.

const rigKey = (meta) => [meta.make ?? '', meta.model ?? ''].join('|')
const bandKey = (band) => (band.index != null ? `#${band.index}` : `:${band.name}`)

// The rig(s) in a photo list. `images`: [{ uuid, meta, enabled? }]. Returns [] when no
// photo is a band image, otherwise one entry per camera model:
//   { key, label, bands: [{ key, index, name, wavelength, thermal, count, reference }],
//     reference: band key, captures: [{ id, panel, images: [{ uuid, band: band key }] }] }
// The reference band is the one the camera's offsets are relative to (the XMP's
// RigRelativesReferenceRigCameraIndex), or the first band when none is named.
export function findRigs(images) {
  const rigs = new Map()
  for (const img of images ?? []) {
    const band = img?.meta?.band
    if (!band?.captureId) continue
    const key = rigKey(img.meta)
    let rig = rigs.get(key)
    if (!rig) {
      rig = {
        key,
        label: [img.meta.make, img.meta.model].filter(Boolean).join(' ') || 'Multispectral camera',
        bands: new Map(),
        captures: new Map(),
        refVotes: new Map(),
      }
      rigs.set(key, rig)
    }
    const bk = bandKey(band)
    let b = rig.bands.get(bk)
    if (!b) {
      b = {
        key: bk,
        index: band.index,
        name: band.name,
        wavelength: band.wavelength,
        thermal: !!band.thermal,
        rigRelatives: band.rigRelatives,
        rigTranslations: band.rigTranslations,
        count: 0,
        reference: false,
      }
      rig.bands.set(bk, b)
    }
    b.count++
    if (band.rigRef != null) rig.refVotes.set(band.rigRef, (rig.refVotes.get(band.rigRef) ?? 0) + 1)
    let cap = rig.captures.get(band.captureId)
    if (!cap) {
      cap = { id: band.captureId, panel: false, images: [] }
      rig.captures.set(band.captureId, cap)
    }
    if (band.panel) cap.panel = true
    cap.images.push({ uuid: img.uuid, band: bk })
  }
  return [...rigs.values()].map((rig) => {
    const bands = [...rig.bands.values()].sort(
      (a, b) => (a.index ?? 1e9) - (b.index ?? 1e9) || a.name.localeCompare(b.name),
    )
    const refIndex = [...rig.refVotes].sort((a, b) => b[1] - a[1])[0]?.[0]
    const ref = bands.find((b) => b.index === refIndex) ?? bands.find((b) => !b.thermal) ?? bands[0]
    ref.reference = true
    return { key: rig.key, label: rig.label, bands, reference: ref.key, captures: [...rig.captures.values()] }
  })
}

// Per photo: its rig, capture and band, and whether it is the capture's reference image.
// Map uuid → { rig, capture, band, reference }.
export function rigMembership(rigs) {
  const out = new Map()
  for (const rig of rigs ?? [])
    for (const cap of rig.captures)
      for (const m of cap.images)
        out.set(m.uuid, { rig: rig.key, capture: cap.id, band: m.band, reference: m.band === rig.reference })
  return out
}

const rad = (d) => (d * Math.PI) / 180
const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
const transpose = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]])

// MicaSense's rotation from RigRelatives degrees: Rx·Ry·Rz (imageprocessing
// image.rotations_degrees_to_rotation_matrix). It takes a ray in the band lens's frame
// into the rig frame.
export function rigRotation(deg) {
  const [x, y, z] = (deg ?? [0, 0, 0]).map(rad)
  const Rx = [
    [1, 0, 0],
    [0, Math.cos(x), -Math.sin(x)],
    [0, Math.sin(x), Math.cos(x)],
  ]
  const Ry = [
    [Math.cos(y), 0, Math.sin(y)],
    [0, 1, 0],
    [-Math.sin(y), 0, Math.cos(y)],
  ]
  const Rz = [
    [Math.cos(z), -Math.sin(z), 0],
    [Math.sin(z), Math.cos(z), 0],
    [0, 0, 1],
  ]
  return mul(mul(Rx, Ry), Rz)
}

// A band lens's pose relative to the reference lens, in the solver's convention: a point
// x in the reference camera's frame is R·x + t in this band's frame (OpenCV axes, as
// MicaSense's). `metres`: the length of one model unit's metre, or null when the model
// has no scale yet, which leaves the lever arm out (a few centimetres between lenses).
// R = Rᵀ_band · R_ref, the inverse of the band → reference homography MicaSense warps
// with; the band lens sits at c = (T_band − T_ref) mm in the reference frame, t = −R·c.
export function bandOffset(band, ref, metres = null) {
  const R = mul(transpose(rigRotation(band.rigRelatives)), rigRotation(ref.rigRelatives))
  const tb = band.rigTranslations,
    tr = ref.rigTranslations
  if (metres == null || tb?.length !== 3) return { R, t: [0, 0, 0] }
  const c = [0, 1, 2].map((i) => ((tb[i] - (tr?.length === 3 ? tr[i] : 0)) / 1000) * metres)
  return { R, t: R.map((row) => -(row[0] * c[0] + row[1] * c[1] + row[2] * c[2])) }
}

// Which pairs to match in a rig: the reference images of different captures with each
// other (as the matching strategy chose them), and every other band image with its own
// capture's reference image. Bands are not matched with each other across captures:
// tracks run through the reference band, and matching blue to NIR is unreliable.
// `pairs`: [[a, b]] of images with `uuid` and `meta`; photos that are no band image keep
// their pairs with each other. A band photo left out of `membership` (a disabled
// calibration-panel capture) is not matched at all.
// Returns the filtered pairs and the in-capture pairs to add, separately, so the caller
// can log both.
export function rigPairs(pairs, membership, images) {
  const kept = []
  for (const pair of pairs) {
    const ma = membership.get(pair[0].uuid),
      mb = membership.get(pair[1].uuid)
    if (!pair[0].meta?.band && !pair[1].meta?.band) kept.push(pair)
    else if (ma && mb && ma.reference && mb.reference && ma.capture !== mb.capture) kept.push(pair)
  }
  const refOf = new Map()
  for (const img of images) {
    const m = membership.get(img.uuid)
    if (m?.reference) refOf.set(`${m.rig}|${m.capture}`, img)
  }
  const added = []
  for (const img of images) {
    const m = membership.get(img.uuid)
    if (!m || m.reference) continue
    const ref = refOf.get(`${m.rig}|${m.capture}`)
    if (ref) added.push([ref, img])
  }
  return { kept, added }
}

// One log line for a rig: "MicaSense Altum-PT: 7 bands (Blue 475 nm, Green 560 nm
// (reference), …), 556 captures, 2 with a calibration panel".
export function rigSummary(rig) {
  const bands = rig.bands
    .map((b) => `${b.name}${b.wavelength ? ` ${b.wavelength} nm` : ''}${b.reference ? ' (reference)' : ''}`)
    .join(', ')
  const panels = rig.captures.filter((c) => c.panel).length
  return (
    `${rig.label}: ${rig.bands.length} bands (${bands}), ${rig.captures.length} captures` +
    (panels ? `, ${panels} with a calibration panel` : '')
  )
}
