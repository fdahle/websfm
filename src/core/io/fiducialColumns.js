// Fiducial marks written as columns rather than rows: one x and one y column per
// mark position, named by that position — `corner_top_left_x_mm` (a camera
// certificate, mm) or `corner_top_left_x` (one image's marks, scan pixels). Each
// position is a fiducial slot (core/sfm/fiducialModel.js), so a mark read this way
// needs no placement by geometry. Shared by the sensor importer (mm) and the image
// fiducial importer (pixels).

export const FIDUCIAL_POSITIONS = [
  { slot: 'corner-tl', label: 'top-left',     corner: 'top_?left|upper_?left' },
  { slot: 'corner-tr', label: 'top-right',    corner: 'top_?right|upper_?right' },
  { slot: 'corner-br', label: 'bottom-right', corner: 'bottom_?right|lower_?right' },
  { slot: 'corner-bl', label: 'bottom-left',  corner: 'bottom_?left|lower_?left' },
  { slot: 'side-top',    label: 'top midside',    side: 'top' },
  { slot: 'side-right',  label: 'right midside',  side: 'right' },
  { slot: 'side-bottom', label: 'bottom midside', side: 'bottom' },
  { slot: 'side-left',   label: 'left midside',   side: 'left' },
]

// The header pattern for one position's x or y column. `unit` 'mm' requires the
// `_mm` suffix; 'px' allows an optional `_px` and rejects `_mm`.
export function fiducialColumnPattern(position, axis, unit) {
  const suffix = unit === 'mm' ? '_?mm' : '(_?px)?'
  return position.corner
    ? new RegExp(`^((corner|fiducial|fid|mark)_?)?(${position.corner})_?${axis}${suffix}$`, 'i')
    : new RegExp(`^(midside|mid_?side|side|mid)_?(${position.side})_?${axis}${suffix}$`, 'i')
}

// { slot: { x: columnIndex, y: columnIndex } } for every position with both columns.
export function fiducialColumns(headerCells, unit) {
  const out = {}
  for (const p of FIDUCIAL_POSITIONS) {
    const find = (axis) => {
      const re = fiducialColumnPattern(p, axis, unit)
      const i = headerCells.findIndex((c) => re.test(String(c ?? '').trim()))
      return i === -1 ? null : i
    }
    const x = find('x'), y = find('y')
    if (x != null && y != null) out[p.slot] = { x, y }
  }
  return out
}
