// Image-name → image-id matching. THE one home for the rule.
//
// Four import paths need to associate a name written by some other tool with an
// image loaded here: GCP observations, camera poses, footprint polygons, and a
// COLMAP model. Each used to carry its own copy of the rule and each copy's
// comment claimed it was "the same matching as" the others — a promise nothing
// enforced, and the copies had already diverged (three did a case-insensitive
// linear scan that ignored path components entirely; only COLMAP's handled
// `images/DSC_0001.JPG`).
//
// Pure: plain data in, plain data out.

/** Last path segment, tolerant of both separators. */
export function basename(n) { return String(n).split(/[\\/]/).pop() }

/** Basename without its final extension. */
export function stem(n) { return basename(n).replace(/\.[^.]+$/, '') }

/**
 * Build a name→id resolver over `entries`.
 *
 * Foreign tools write whatever path they had at the time (often a bare filename,
 * sometimes a relative path, sometimes a different case or a transcoded
 * extension); websfm images key by `name`. Match progressively looser, and only
 * fall to a looser tier when every stricter one missed — so an exact hit always
 * beats a stem hit no matter where the two sit in the list:
 *
 *   1. exact name        2. basename        3. lowercase basename        4. lowercase stem
 *
 * Within a tier the first entry in list order wins. An unmatched name → null.
 *
 * Indexing up front makes a reconcile pass O(N+M) instead of O(N·M) — the store
 * callers resolve every observation against every image on each image-list change.
 *
 * @param {Array<object>} entries images to match against
 * @param {{ key?: string }} [opts] which property holds the id (`'id'` in the
 *   stores, `'uuid'` for COLMAP import)
 * @returns {(name: string|null|undefined) => any|null}
 */
export function makeNameResolver(entries, { key = 'id' } = {}) {
  const exact = new Map(), base = new Map(), baseLower = new Map(), stemLower = new Map()
  for (const e of entries ?? []) {
    const id = e?.[key]
    const name = e?.name
    if (name == null || id == null) continue
    if (!exact.has(name)) exact.set(name, id)
    const b = basename(name)
    if (!base.has(b)) base.set(b, id)
    const bl = b.toLowerCase()
    if (!baseLower.has(bl)) baseLower.set(bl, id)
    const sl = stem(name).toLowerCase()
    if (!stemLower.has(sl)) stemLower.set(sl, id)
  }
  return (name) => {
    if (name == null || name === '') return null
    return exact.get(name)
      ?? base.get(basename(name))
      ?? baseLower.get(basename(name).toLowerCase())
      ?? stemLower.get(stem(name).toLowerCase())
      ?? null
  }
}
