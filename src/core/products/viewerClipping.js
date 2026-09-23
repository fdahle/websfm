// Keep the near plane close as the user approaches the orbit target. The far
// plane still includes the entire scene when panning or zooming out.
export function viewerClipping(radius, distance, manualNear = 0) {
  const r = Math.max(0.001, radius)
  const d = Math.max(0.000001, distance)
  const near = manualNear > 0 ? manualNear : Math.max(0.000001, Math.min(r * 0.0001, d * 0.0001))
  return { near, far: Math.max(r * 100, d + r * 4, near * 100) }
}
