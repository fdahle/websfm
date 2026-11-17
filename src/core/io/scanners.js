// Film scanners that write their own make and model into a scan's tags. A scan of an
// aerial photograph carries the tags of the device that digitised the film (the TMA
// scans: XMP tiff:Make "Better Light", tiff:Model "Model Super10K", a scanning back),
// not of the camera that took the photo. Read as the camera, they named the sensor
// after the scanner and grouped the photos of every camera scanned on it into one.
//
// A maker that only builds scanners matches on its make; one that also builds cameras
// (Hasselblad, Nikon, Epson, Vexcel, Leica, Zeiss) only on a scanner model.
// Pure: plain data in, plain data out.

const SCANNERS = [
  { make: /^better\s*light/i },
  { make: /^imacon/i },
  { make: /^microtek/i },
  { make: /^plustek/i },
  { make: /^reflecta/i },
  { make: /^wehrli/i },
  { make: /hasselblad/i, model: /flextight|imacon/i },
  { make: /nikon/i, model: /coolscan|\bls-\d/i },
  { make: /epson|seiko/i, model: /perfection|expression|^gt-\d|^ds-\d/i },
  { make: /canon/i, model: /canoscan/i },
  // Photogrammetric film scanners.
  { make: /vexcel|microsoft/i, model: /ultrascan/i },
  { make: /leica|lh systems|helava/i, model: /^dsw/i },
  { make: /intergraph|z\/i|zeiss/i, model: /photoscan|^scai/i },
]

// The scanner a make and model name, as one label ("Better Light Model Super10K"),
// or null when they name a camera (or nothing).
export function filmScannerOf(make, model) {
  const mk = String(make ?? '').trim()
  const md = String(model ?? '').trim()
  if (!mk && !md) return null
  const hit = SCANNERS.some((s) => s.make.test(mk) && (!s.model || s.model.test(md)))
  if (!hit) return null
  // A model that repeats the make ("Nikon" / "Nikon LS-5000") is shown once.
  return md.toLowerCase().startsWith(mk.toLowerCase()) ? md : [mk, md].filter(Boolean).join(' ')
}
