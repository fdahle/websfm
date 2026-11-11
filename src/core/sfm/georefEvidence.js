// The evidence a georeference was fitted on, as one string: the georeference is kept
// while the model, the photos, the GCPs and the camera positions are what they were
// (stores/reconstruction/georeferencing.js), and saved with that string.
//
// A record's `imageName` is left out. It is the name the record was imported under; its
// link to a photo is `imageId`, and relinkImageRecord (core/io/nameMatch.js) renames a
// linked record to its photo's name, on reopen or when a photo is renamed. Counting the
// name dropped the georeference of every project placed by a position or marker file
// that names the photos in another case or without the extension, on every reopen.
//
// Pure: plain data in, a string out.

const withoutNames = (key, value) => (key === 'imageName' ? undefined : value)

export const georefEvidenceKey = (evidence) => JSON.stringify(evidence, withoutNames)

// A key saved before the names were left out, in the form georefEvidenceKey gives now
// (a JSON round trip writes the same string as the first serialisation did).
export function currentEvidenceKey(key) {
  if (typeof key !== 'string') return key
  try {
    return JSON.stringify(JSON.parse(key), withoutNames)
  } catch {
    return key
  }
}
