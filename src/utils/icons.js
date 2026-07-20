// Uniform black & white outline icon set.
//
// Each entry is the *inner* SVG markup for a 24x24 viewBox. They are rendered by
// src/components/Icon.vue inside an <svg> that sets:
//   fill="none" stroke="currentColor" stroke-width="1.5"
//   stroke-linecap="round" stroke-linejoin="round"
// so every icon inherits the button's text color (and dims when disabled).
//
// Keep paths centered in the 24x24 box with a little padding (~2px) for a
// consistent visual weight across the ribbon.

export const icons = {
  // ── View / Camera ──────────────────────────────────────────────────────────
  'view-top': `
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M12 16V9" />
    <path d="M9 12l3-3 3 3" />`,
  'view-side': `
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M8 12h7" />
    <path d="M12 9l3 3-3 3" />`,
  'view-bottom': `
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M12 8v7" />
    <path d="M9 12l3 3 3-3" />`,
  'view-left': `
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M16 12H9" />
    <path d="M12 9l-3 3 3 3" />`,
  'view-right': `
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M8 12h7" />
    <path d="M12 9l3 3-3 3" />`,
  'view-front': `
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <rect x="9" y="9" width="6" height="6" rx="1" />`,
  'view-back': `
    <rect x="7" y="7" width="13" height="13" rx="1.5" />
    <path d="M4 16V4h12" />`,
  'view-reset': `
    <path d="M4 11a8 8 0 1 1 1.5 5" />
    <path d="M4 17v-5h5" />`,
  grid: `
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M4 10h16M4 14h16M10 4v16M14 4v16" />`,
  'fit-view': `
    <path d="M4 9V5a1 1 0 0 1 1-1h4" />
    <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
    <path d="M4 15v4a1 1 0 0 0 1 1h4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />`,
  'zoom-in': `
    <circle cx="11" cy="11" r="6" />
    <path d="M15.5 15.5L21 21" />
    <path d="M8.5 11h5M11 8.5v5" />`,
  'zoom-out': `
    <circle cx="11" cy="11" r="6" />
    <path d="M15.5 15.5L21 21" />
    <path d="M8.5 11h5" />`,
  console: `
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 10l3 2.5L7 15" />
    <path d="M13 15h4" />`,

  // ── Import ──────────────────────────────────────────────────────────────────
  image: `
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="M21 16l-5-5L5 20" />`,
  camera: `
    <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="12.5" r="3.5" />`,
  // Camera *pose*, not the physical sensor: the classic SfM frustum — image plane
  // plus two rays converging on the projection centre. Deliberately distinct from
  // `camera` (a photo camera = a sensor / calibration group).
  'camera-pose': `
    <rect x="5" y="4" width="14" height="9.5" rx="1" />
    <path d="M12 19L5 13.5M12 19l7-5.5" />
    <circle cx="12" cy="19.5" r="1.3" />`,
  // Lens calibration: the checkerboard target, the universal symbol for it.
  calibration: `
    <rect x="4" y="4" width="16" height="16" rx="1" />
    <path d="M4 12h16M12 4v16" />
    <path d="M4 4h8v8H4zM12 12h8v8h-8z" fill="currentColor" stroke="none" />`,
  target: `
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />`,
  'map-pin': `
    <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
    <circle cx="12" cy="10" r="2.5" />`,

  // ── Reconstruct ─────────────────────────────────────────────────────────────
  sparkles: `
    <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z" />
    <path d="M18 15l.7 1.8L20.5 17.5l-1.8.7L18 20l-.7-1.8L15.5 17.5l1.8-.7z" />`,
  link: `
    <path d="M9.5 14.5l5-5" />
    <path d="M10.5 6.5l1-1a3.5 3.5 0 0 1 5 5l-2 2" />
    <path d="M13.5 17.5l-1 1a3.5 3.5 0 0 1-5-5l2-2" />`,
  cube: `
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5" />
    <path d="M12 12v9" />`,
  cloud: `
    <path d="M7 18a4 4 0 0 1-.5-7.97A5 5 0 0 1 16 9.5a3.5 3.5 0 0 1 .5 6.96" />
    <path d="M7 18h9.5" />`,
  // Sparse model = tie points triangulated from two camera frustums. The rays are
  // what separates it from `point-cloud` (dense, no cameras).
  'sparse-model': `
    <path d="M4.5 18l3-2.2v4.4z" />
    <path d="M19.5 18l-3-2.2v4.4z" />
    <path d="M7 16L12 7M17 16L12 7" opacity="0.35" />
    <circle cx="12" cy="6.5" r="1.1" />
    <circle cx="8.8" cy="10.5" r="1.1" />
    <circle cx="15.2" cy="10" r="1.1" />
    <circle cx="12" cy="13" r="1.1" />`,
  table: `
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M3 9h18M3 14h18M9 4v16M15 4v16" />`,
  list: `
    <path d="M8 7h11M8 12h11M8 17h11" />
    <circle cx="4.5" cy="7" r="0.8" />
    <circle cx="4.5" cy="12" r="0.8" />
    <circle cx="4.5" cy="17" r="0.8" />`,

  // ── Products (DEM / Ortho) ──────────────────────────────────────────────────
  dem: `
    <path d="M3 18l5-8 3 4 3-5 4 6 3-3" />
    <path d="M3 21h18" />`,
  // Orthophoto = a *rectified image*, so it reads as a photo (sun + terrain) with a
  // faint map grid over it — not the old cube, which said "3D model".
  ortho: `
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <path d="M3.5 16.5l4.5-4.5 3.5 3 4-4.5 5 6" />
    <circle cx="8" cy="9" r="1.3" />
    <path d="M9.5 5v14M15 5v14M3.5 10h17" opacity="0.28" />`,
  // Stacked georeferenced tiles — imported reference raster (DEM *or* orthophoto).
  layers: `
    <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" />
    <path d="M3.5 12.5L12 17l8.5-4.5" opacity="0.7" />
    <path d="M3.5 16.5L12 21l8.5-4.5" opacity="0.45" />`,

  // ── Export ──────────────────────────────────────────────────────────────────
  'point-cloud': `
    <circle cx="7" cy="8" r="1" /><circle cx="12" cy="6" r="1" /><circle cx="17" cy="9" r="1" />
    <circle cx="6" cy="14" r="1" /><circle cx="11" cy="13" r="1" /><circle cx="16" cy="15" r="1" />
    <circle cx="9" cy="18" r="1" /><circle cx="14" cy="19" r="1" />`,
  download: `
    <path d="M12 4v10" />
    <path d="M8 11l4 4 4-4" />
    <path d="M5 19h14" />`,

  // ── Other ───────────────────────────────────────────────────────────────────
  settings: `
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 13H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 .9-1.4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.4.9H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5.9z" />`,
  info: `
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none" />`,
  // Quality report: a document with a bar chart.
  report: `
    <path d="M6 3.5h8l4 4v13H6z" />
    <path d="M14 3.5v4h4" />
    <path d="M9 17v-3.5M12 17v-6M15 17v-2.5" />`,
  book: `
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H12v15H5.5A1.5 1.5 0 0 0 4 20.5z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H12v15h6.5a1.5 1.5 0 0 1 1.5 1.5z" />`,

  // ── Picture (image context) ─────────────────────────────────────────────────
  keypoints: `
    <circle cx="12" cy="12" r="2" />
    <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
    <circle cx="6" cy="6" r="1" /><circle cx="18" cy="18" r="1" /><circle cx="18" cy="6" r="1" /><circle cx="6" cy="18" r="1" />`,
  mask: `
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none" />`,
  // Depth map = an image frame holding a near→far ramp. The old stacked-planes
  // shape read as "layers" (it is now the `layers` icon) rather than as depth.
  depth: `
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <path d="M7 19V8.5" />
    <path d="M10.5 19v-6.5" opacity="0.75" />
    <path d="M14 19v-4.5" opacity="0.5" />
    <path d="M17.5 19v-2.5" opacity="0.3" />`,
  pencil: `
    <path d="M5 19l1-4L16 5l3 3L9 18z" />
    <path d="M14 7l3 3" />`,
  eraser: `
    <path d="M8 17l-3-3a1.5 1.5 0 0 1 0-2L13 4a1.5 1.5 0 0 1 2 0l4 4a1.5 1.5 0 0 1 0 2l-7 7z" />
    <path d="M8 17h11" />`,
  x: `<path d="M6 6l12 12M18 6L6 18" />`,
  brush: `<circle cx="12" cy="12" r="5" />`,
  rect: `<rect x="5" y="7" width="14" height="10" rx="1" />`,
  invert: `
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />`,
  undo: `
    <path d="M8 6L4 10l4 4" />
    <path d="M4 10h10a5 5 0 0 1 0 10h-3" />`,
  redo: `
    <path d="M16 6l4 4-4 4" />
    <path d="M20 10H10a5 5 0 0 0 0 10h3" />`,
  remove: `
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9 9l6 6M15 9l-6 6" />`,

  // ── Tools ───────────────────────────────────────────────────────────────────
  // Ground footprint: a perspective quadrilateral with the camera nadir at top.
  footprint: `
    <circle cx="12" cy="4" r="1.5" />
    <path d="M12 5.5L8 12M12 5.5L16 12" opacity="0.6" />
    <path d="M5 13l7-2 7 2-7 7z" />`,
}

export default icons
