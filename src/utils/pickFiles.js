// The browser's file chooser without a permanently mounted <input type=file>. The
// input is attached (hidden) only while the chooser is open — a detached one can be
// collected before it fires — and removed on `change` or `cancel`. `onPick` gets
// the change event, the same shape an `<input @change>` handler receives, so the
// existing pick handlers (which read `event.target.files`) work unchanged.
export function pickFiles({ accept = '', multiple = false, directory = false } = {}, onPick) {
  const input = document.createElement('input')
  input.type = 'file'
  input.hidden = true
  if (accept) input.accept = accept
  input.multiple = multiple
  if (directory) input.webkitdirectory = true
  const remove = () => input.remove()
  input.addEventListener('change', (event) => {
    try { onPick(event) } finally { remove() }
  }, { once: true })
  input.addEventListener('cancel', remove, { once: true })
  document.body.appendChild(input)
  input.click()
}

// What each picker offers. Kept as data so the dispatch and the dialogs that open
// a chooser (the SfM source dialog, the project picker) agree on the filters.
export const FILE_PICKERS = {
  images:          { accept: 'image/*', multiple: true },
  video:           { accept: 'video/*,.mp4,.m4v,.mov,.webm,.mkv,.ogv,.avi' },
  gcps:            { accept: '.csv,.txt,.tsv,.gcp,.pts,.geojson,.json,application/geo+json,text/*' },
  cameras:         { accept: '.csv,.txt,.tsv,.cam,text/*' },
  imageFiducials:  { accept: '.csv,.txt,.tsv,text/*' },
  cameraFiducials: { accept: '.csv,.txt,.tsv,text/*' },
  sfmFiles:        { accept: '.db,.sqlite,.txt,.bin,.zip,.json,.nvm', multiple: true },
  sfmFolder:       { directory: true, multiple: true },
  cloud:           { accept: '.ply,.las,.laz,.xyz,.pts' },
  raster:          { accept: '.tif,.tiff' },
  project:         { accept: '.websfm,.zip' },
}
