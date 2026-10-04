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
  // Project-summary digest: a clipboard with a health-pulse line — a report of
  // reconstruction health (Debug ▸ Project Summary).
  summary: `
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <rect x="9" y="2.5" width="6" height="3" rx="1" />
    <path d="M8 13h2l1.5 3 2-6 1.5 3h1" />`,

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
  // Scale bar: a ruler laid between two marked endpoints — the graduations are
  // what distinguishes it from the plain 'link'/measure glyphs.
  ruler: `
    <rect x="2.5" y="8.5" width="19" height="7" rx="1" />
    <path d="M6.5 8.5v3M10 8.5v4.5M13.5 8.5v3M17 8.5v4.5" />`,
  // Measure group (DEM / orthophoto tab): planimetric area, elevation profile,
  // cut/fill volume.
  area: `
    <path d="M4 7l7-3.5 9 4.5-2.5 11L6 19z" stroke-dasharray="2.2 1.8" />
    <circle cx="4" cy="7" r="1.3" /><circle cx="11" cy="3.5" r="1.3" /><circle cx="20" cy="8" r="1.3" />
    <circle cx="17.5" cy="19" r="1.3" /><circle cx="6" cy="19" r="1.3" />`,
  profile: `
    <path d="M3 20.5h18M3 20.5V3.5" />
    <path d="M5 16l4-6 3 3 4-7 4 5" />`,
  volume: `
    <path d="M2.5 19.5h19" />
    <path d="M4 19.5c2-5 4.5-9 8-9s6 4 8 9" />
    <path d="M7 15.5h10" stroke-dasharray="1.6 1.6" />`,
  'map-pin': `
    <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
    <circle cx="12" cy="10" r="2.5" />`,
  // Aerial survey: an aircraft seen from below, i.e. the nadir view the imagery
  // is taken from.
  plane: `
    <path d="M12 3a1.6 1.6 0 0 1 1.6 1.6v3.7l7.4 4.3v2l-7.4-2.2v3.9l2.3 1.7v1.6L12 18.9l-3.9 1.6v-1.6l2.3-1.7v-3.9L3 15.5v-2l7.4-4.3V4.6A1.6 1.6 0 0 1 12 3z" />`,

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
  // A document with a folded corner — a single project file (.websfm).
  file: `
    <path d="M6.5 3.5h6.6L17.5 8v11.3a1.2 1.2 0 0 1-1.2 1.2H6.5a1.2 1.2 0 0 1-1.2-1.2V4.7a1.2 1.2 0 0 1 1.2-1.2z" />
    <path d="M13 3.6V8h4.4" />
    <path d="M8.3 12.5h5.4" />
    <path d="M8.3 15.5h5.4" />`,
  // Floppy-disk "save" and an open folder — whole-project file I/O (.websfm).
  save: `
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9.7L20 8.8v9.7A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M8 4v5h7V4" />
    <path d="M7.5 20v-6h9v6" />`,
  'folder-open': `
    <path d="M3 8.5V6.2A1.2 1.2 0 0 1 4.2 5h4.3l2 2.4h6.3A1.2 1.2 0 0 1 18 8.6v1.4" />
    <path d="M3 8.5h17.2a.9.9 0 0 1 .87 1.14l-2.1 8A1.2 1.2 0 0 1 17.8 18.5H4.2A1.2 1.2 0 0 1 3 17.3z" />`,
  // A closed folder on disk — the counterpart of `browser`, for "where do the
  // project files live", not for an open/browse action (`folder-open`).
  folder: `
    <path d="M3.5 7.2A1.7 1.7 0 0 1 5.2 5.5h3.9l2 2.6h7.7a1.7 1.7 0 0 1 1.7 1.7v7.5a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z" />`,
  // Browser storage (OPFS): a browser window, not a disk/database — what the
  // user sees is "the files stay inside this browser".
  browser: `
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M3 9h18" />
    <circle cx="6.2" cy="6.8" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="8.8" cy="6.8" r="0.7" fill="currentColor" stroke="none" />`,

  // ── Other ───────────────────────────────────────────────────────────────────
  // Crisp geometric cog (8 teeth, computed coordinates) — the old Feather gear
  // rendered as a blobby, indistinct shape at ribbon size.
  settings: `
    <path d="M 21.12 10.78 L 21.12 13.22 L 18.96 13.85 L 18.23 15.62 L 19.31 17.58 L 17.58 19.31 L 15.62 18.23 L 13.85 18.96 L 13.22 21.12 L 10.78 21.12 L 10.15 18.96 L 8.38 18.23 L 6.42 19.31 L 4.69 17.58 L 5.77 15.62 L 5.04 13.85 L 2.88 13.22 L 2.88 10.78 L 5.04 10.15 L 5.77 8.38 L 4.69 6.42 L 6.42 4.69 L 8.38 5.77 L 10.15 5.04 L 10.78 2.88 L 13.22 2.88 L 13.85 5.04 L 15.62 5.77 L 17.58 4.69 L 19.31 6.42 L 18.23 8.38 L 18.96 10.15 Z" />
    <circle cx="12" cy="12" r="3.1" />`,
  info: `
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none" />`,
  // Theme trio — the ribbon button swaps between them to report the current
  // choice, so they must read as one family at 24px.
  sun: `
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.4M12 19v2.4M2.6 12h2.4M19 12h2.4M5.4 5.4l1.7 1.7M16.9 16.9l1.7 1.7M18.6 5.4l-1.7 1.7M7.1 16.9l-1.7 1.7" />`,
  moon: `<path d="M20 14.2A8.4 8.4 0 1 1 9.8 4a6.9 6.9 0 0 0 10.2 10.2Z" />`,
  // "System": one disc, half of it filled — light and dark decided elsewhere.
  'theme-system': `
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />`,
  // System info: a processor chip with pins — reads as "hardware / diagnostics".
  cpu: `
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <rect x="10" y="10" width="4" height="4" rx="0.5" />
    <path d="M9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3M4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3" />`,
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
