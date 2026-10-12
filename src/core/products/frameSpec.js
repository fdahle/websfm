// Frame specs ↔ frames. Pure, shared by the products worker (which builds rasters
// in a frame) and the main thread (which places those rasters on the map), so
// both rebuild a recorded frame identically. Frames carry closures and cannot
// cross postMessage; a spec/descriptor is the serialisable form.

import { buildLocalFrame, makeFrame, frameFromScaledLocal } from './projection.js'
import { frameFromSimilarity } from './georef.js'

// Rebuild a projection frame from a spec. 'similarity' comes from a georeference
// fit; 'scaled-local' is the local frame with a scale-bar factor (metric, no
// CRS); a 'local' spec that already carries origin/east is a fully resolved
// descriptor, otherwise the frame is derived from the scene (cameras' up, points'
// centroid — projection.js buildLocalFrame).
//   cameras: iterable of { R, t }   points: iterable of { x, y, z }
export function frameFromSpec(spec, cameras = [], points = []) {
  if (spec?.kind === 'similarity') {
    return frameFromSimilarity({ scale: spec.scale, R: spec.R, t: spec.t, local: spec.local ?? null }, spec.crs, spec)
  }
  // The base descriptor's basis is unit-length; NEVER hand makeFrame scaled
  // vectors (see frameFromScaledLocal). The base half may itself be an
  // unresolved request, so recurse rather than duplicating the fallback.
  if (spec?.kind === 'scaled-local') {
    const base = frameFromSpec({ ...spec, kind: 'local' }, cameras, points)
    return frameFromScaledLocal(base, spec.scale) ?? base
  }
  if (spec && spec.origin && spec.east) return makeFrame(spec)
  return buildLocalFrame(cameras, points)
}

// A serialisable snapshot of a frame (basis + metadata), recorded on a product
// so later passes — the ortho, the map — reuse the exact frame its grid was built in.
export function describeFrame(frame, spec) {
  if (spec?.kind === 'similarity') return { ...spec }
  return {
    // frame.origin/east/north/up are the UNSCALED basis for a scaled-local frame
    // too (frameFromScaledLocal keeps the basis orthonormal and carries the factor
    // separately), so one descriptor shape covers both.
    kind: spec?.kind === 'scaled-local' ? 'scaled-local' : 'local',
    ...(spec?.kind === 'scaled-local' ? { scale: frame.scale ?? spec.scale } : {}),
    origin: frame.origin, east: frame.east, north: frame.north, up: frame.up,
    crs: frame.crs, unit: frame.unit, source: frame.source,
  }
}
