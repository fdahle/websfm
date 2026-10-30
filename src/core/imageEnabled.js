// A disabled photo (image list ▸ Disable, or Tools ▸ Reduce overlap) keeps its features,
// matches, pose and any saved depth map, but every run started afterwards leaves it out:
// Sparse Reconstruction, depth maps, the dense cloud, the orthophoto and mesh texture.
// Enable brings it back. Saved as `enabled: false` on the image record; absent means on,
// so projects from before the flag open unchanged.

export const isImageEnabled = (img) => img?.enabled !== false

// The uuids of the disabled images, for the runs that work from uuids (cameras, maps).
export function disabledUuids(images) {
  const out = new Set()
  for (const img of images ?? []) if (img?.enabled === false) out.add(img.uuid)
  return out
}
