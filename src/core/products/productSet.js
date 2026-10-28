// Several products of a kind (dense clouds, meshes, DEMs, orthophotos), one of them
// the main one, and which were built on inputs that have changed since.
//
// A rebuild adds a new product unless the build dialog's Replace option is on, so
// older results stay until the user removes them. The steps that need an input (a
// DEM needs a cloud, an ortho a DEM) use the main one of its kind, as Metashape uses
// its default. Pure: plain records in, plain values out.

/** The kinds that have a main product of their own (the sparse model's is `mainSparseId`). */
export const MAIN_KINDS = ['dense', 'mesh', 'dem', 'ortho']

/**
 * "DEM", or "DEM 2", "DEM 3" … when the name is taken.
 * @param {string} base
 * @param {Iterable<string>} taken names already in use
 */
export function nextProductName(base, taken) {
  const names = new Set(taken)
  if (!names.has(base)) return base
  let n = 2
  while (names.has(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/**
 * The main record of a kind: the one `mainId` names, else the newest (last) one the
 * pipeline built. An imported cloud is main only when named, or when it is all there
 * is: a reference survey must not become the input of the next build by default.
 * @template {{ id: string, kind: string, imported?: boolean }} T
 * @param {T[]} records
 * @param {string} kind
 * @param {string|null|undefined} mainId
 * @returns {T|null}
 */
export function mainOf(records, kind, mainId) {
  let built = null
  let any = null
  for (const r of records) {
    if (r.kind !== kind) continue
    if (r.id === mainId) return r
    any = r
    if (!r.imported) built = r
  }
  return built ?? any
}

/**
 * What a product records about one input it was built from.
 * @param {{ id: string, kind: string, createdAt?: number }} record
 * @returns {{ id: string, kind: string, createdAt: number|null }}
 */
export const stampOf = (record) => ({ id: record.id, kind: record.kind, createdAt: record.createdAt ?? null })

/**
 * Why each product is outdated: an input it was built from (`basedOn`) has been
 * rebuilt since, or is itself outdated. A sparse input must also still be the main
 * model, since the products are in its frame. An input that was removed leaves a
 * product as it was, except a sparse one.
 * @param {{ id: string, kind: string, name?: string, createdAt?: number,
 *   basedOn?: { id: string, kind: string, createdAt: number|null }[] }[]} records
 *   every cloud and raster product of the project
 * @param {{ mainSparseId?: string|null }} [ctx]
 * @returns {Map<string, string>} id → reason, for the outdated ones only
 */
export function outdatedReasons(records, { mainSparseId = null } = {}) {
  const byId = new Map(records.map((r) => [r.id, r]))
  const memo = new Map()
  const quote = (r) => `"${r.name ?? r.kind}"`

  function reasonOf(r) {
    if (memo.has(r.id)) return memo.get(r.id)
    memo.set(r.id, null) // a cycle (never built, but never loop) reads as current
    let reason = null
    for (const b of r.basedOn ?? []) {
      const src = byId.get(b.id)
      if (b.kind === 'sparse') {
        if (!src) reason = 'the sparse model it was built on was removed'
        else if (src.id !== mainSparseId) reason = `it was built on ${quote(src)}, not the main sparse model`
        else if ((src.createdAt ?? null) !== b.createdAt) reason = 'the sparse model has changed since it was built'
      } else if (src) {
        if ((src.createdAt ?? null) !== b.createdAt) reason = `${quote(src)} was rebuilt since`
        else if (reasonOf(src)) reason = `it was built on ${quote(src)}, which is outdated`
      }
      if (reason) break
    }
    memo.set(r.id, reason)
    return reason
  }

  const out = new Map()
  for (const r of records) {
    const reason = reasonOf(r)
    if (reason) out.set(r.id, reason)
  }
  return out
}
