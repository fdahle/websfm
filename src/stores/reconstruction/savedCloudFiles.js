// Which committed sidecar files already hold a cloud's heavy data, so a save only
// writes the clouds that changed. Without it every persist() re-serialised and
// rewrote every cloud: a single 3D lasso stroke cost > 1 GB of widening, copying and
// writing with two 25 M-point clouds open, for one cloud's worth of change.
//
// The key is the IDENTITY of the heavy typed arrays (pos, col, nrm, idx and each
// attribute array, plus the counts that slice them). That is sound because the
// store never writes into a cloud's arrays in place: every edit — crop, filter,
// mask stroke, merge, re-fuse, re-mesh, a worker round trip — produces new arrays,
// and the in-place edits that do exist (rename, visibility, style) touch metadata,
// which is re-serialised on every save anyway. A new array identity simply misses
// the cache and the cloud is written in full, as before. Sparse clouds are never
// reused: their heavy data is an array of point objects with Map-backed tracks, whose
// contents an identity check cannot vouch for (and they are small next to dense).
//
// Entries also carry the project id. The cache only ever says "these files were
// committed"; the saver re-checks each one exists at the recorded size inside the
// save lock before relying on it, and falls back to a full write when not.

// Heavy-data identity of a dense/mesh cloud; null for kinds that are never reused.
export function heavyIdentity(c) {
  if (!c || (c.kind !== 'dense' && c.kind !== 'mesh') || !c.pos) return null
  const id = [c.kind, c.count ?? null, c.nVerts ?? null, c.pos, c.col ?? null, c.nrm ?? null, c.idx ?? null]
  for (const [name, values] of Object.entries(c.attributes ?? {})) id.push(name, values)
  return id
}

function sameIdentity(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function createSavedCloudFiles() {
  let byPos = new WeakMap()
  return {
    // The files to reuse for `c` in project `projectId`, or null to write it in full.
    lookup(c, projectId) {
      const id = heavyIdentity(c)
      if (!id) return null
      const e = byPos.get(c.pos)
      return e && e.projectId === projectId && sameIdentity(e.identity, id) ? e.files : null
    },
    // After a committed save (or a load): `files` is that cloud's { key: { name, bytes } }.
    remember(c, projectId, files) {
      const id = heavyIdentity(c)
      if (!id || !files?.pos) return
      byPos.set(c.pos, { projectId, identity: id, files: { ...files } })
    },
    clear() { byPos = new WeakMap() },
  }
}
