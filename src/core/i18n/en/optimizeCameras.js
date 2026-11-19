// Optimize Cameras (components/modals/model/OptimizeCamerasModal.vue).
export default {
  title: 'Optimize Cameras',
  noModel: 'Build the sparse model first.',
  source: 'Source',
  step: 'Re-adjust the cameras',
  freeParameters: 'Free parameters',
  hint: 'The principal point and the lens need a well-spread, strongly overlapping block with varied viewing angles.',
  refine: {
    f: 'Focal length',
    fcxcy: 'Focal length + principal point',
    full: 'Full lens (f, cx, cy, k1–k3, p1, p2)',
  },
  replaces:
    'The model is replaced in place: its depth maps and georeference are cleared, and the dense cloud, mesh, DEM ' +
    'and orthophoto are kept, marked outdated. <strong>Reconstruct ▸ Rebuild Outdated</strong> rebuilds them. ' +
    'Imported data and your edited copies are kept.',
  cancel: 'Cancel',
  run: 'Optimize',
  needsModel: 'Needs a sparse model (Reconstruct ▸ Sparse Model)',
}
