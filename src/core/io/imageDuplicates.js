// Picked files that duplicate an image already in the project, or an earlier file
// in the same pick. The ingest's own id (name-size-lastModified, utils/image.js)
// catches only the very same file picked again: a copy keeps its name and bytes
// but usually gets a new modification time (a subset copied out of a full set,
// then the full set added). Name + size is the match here; two different photos
// sharing both is unlikely enough that the user's answer covers it.

// Byte size of an image's original. A restored image has no File until its copy
// is read back, but its id still carries the size: `${sourceName}-${size}-${mtime}`
// (plus a `#n` suffix on a duplicate added anyway).
export function imageFileSize(img) {
  if (img?.file?.size != null) return img.file.size
  const name = img?.sourceName ?? img?.name
  if (typeof img?.id !== 'string' || !name || !img.id.startsWith(`${name}-`)) return null
  const size = Number(img.id.slice(name.length + 1).split('-')[0])
  return Number.isFinite(size) ? size : null
}

const keyOf = (name, size) => `${name}\u0000${size}`

// The Set of `files` that duplicate an image in `images` or an earlier file.
export function findDuplicateFiles(files, images) {
  const seen = new Set()
  for (const img of images) {
    const size = imageFileSize(img)
    if (size != null) seen.add(keyOf(img.sourceName ?? img.name, size))
  }
  const dups = new Set()
  for (const file of files) {
    const key = keyOf(file.name, file.size)
    if (seen.has(key)) dups.add(file)
    else seen.add(key)
  }
  return dups
}

// `name` made unique against `taken` by a " (2)", " (3)" … before the extension.
export function uniqueImageLabel(name, taken) {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const label = `${stem} (${n})${ext}`
    if (!taken.has(label)) return label
  }
}
