// `images/index.csv`: which file under images/ is which photo. The originals are
// stored by uuid (two photos often share a name, and a name one file system takes
// another may refuse), so a person browsing a project folder cannot tell them apart.
// This list names them. It is written alongside project.json and never read back:
// project.json stays the record, and a missing or stale index costs nothing.
//
// Pure: plain data in, plain data out.

export const IMAGE_INDEX_FILE = 'index.csv'

function csvCell(v) {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The index as CSV text: one row per image, in list order. `name` is the label shown
 * in WebSfM, `original_name` the file's name when it was imported.
 * @param {{ uuid: string, name: string, sourceName?: string }[]} images
 * @returns {string}
 */
export function imageIndexCsv(images) {
  const rows = ['file,name,original_name']
  for (const img of images) rows.push([img.uuid, img.name, img.sourceName ?? img.name].map(csvCell).join(','))
  return rows.join('\n') + '\n'
}
