// What each step of Products ▸ Reflectance map does to this project
// (ReflectanceMapModal.vue).
import { plural, fmtCount, fmtLength } from './format.js'
import { resolveCalibration } from '../products/reflectanceMap.js'

const TEXT = {
  'panel+dls':
    "reflectance from the panel's known albedo, carried through the flight by the sun sensor's reading at each photo.",
  'panel': "reflectance from the panel's known albedo, assuming the light stayed as it was over the panel.",
  'dls': "reflectance from the sun sensor's reading at each photo.",
  'radiance': 'radiance (W/m²/sr/nm) as the camera measured it, not reflectance.',
}

// project: { rig: { label, bands, captures, panelCaptures, dls (some photo has a sun-sensor
// reading), thermal (it has a thermal band) } | null, dem: { width, height, gsd, unit } | null }
export function reflectanceEffects(s, { rig = null, dem = null } = {}) {
  if (!rig) return { calibration: 'No multispectral photos in this project.', grid: '' }
  const mode = resolveCalibration(s.calibration, { havePanel: rig.panelCaptures > 0, haveDls: !!rig.dls })
  const missing =
    (s.calibration === 'panel' || s.calibration === 'panel+dls') && !rig.panelCaptures
      ? 'No capture shows the calibration panel: the bands fall back to the sun sensor, or to radiance. '
      : (s.calibration === 'dls' || s.calibration === 'panel+dls') && !rig.dls
        ? 'No photo has a sun-sensor reading. '
        : ''
  const source =
    mode.startsWith('panel') && rig.panelCaptures
      ? `${plural(rig.panelCaptures, 'panel capture')}: `
      : s.calibration === 'auto'
        ? 'Auto: '
        : ''
  const calibration = missing + source + TEXT[mode] + (rig.thermal ? ' The thermal band is in °C.' : '')
  let grid
  const bands = rig.bands
  if (!dem) grid = 'Build a DEM first: the map lies on it.'
  else if (!(s.gsd > 0))
    grid =
      `Auto: the reference band's own ground pixel, measured over the DEM when the run starts; ` +
      `${plural(bands, 'band')}, NaN where no photo sees the ground.`
  else {
    const w = Math.max(1, Math.round((dem.width * dem.gsd) / s.gsd)),
      h = Math.max(1, Math.round((dem.height * dem.gsd) / s.gsd))
    const mb = (w * h * bands * 4) / 2 ** 20
    grid =
      `${fmtCount(w)} × ${fmtCount(h)} cells at ${fmtLength(s.gsd, dem.unit || 'units')}, ` +
      `${plural(bands, 'band')}: about ${fmtCount(Math.round(mb))} MB before compression.`
  }
  return { calibration, grid }
}
