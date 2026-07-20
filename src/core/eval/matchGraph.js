// Pure match-graph health for Evaluate ▸ Graph Health (PLAN-eval-views step 5).
// Union-find over ACCEPTED edges only — a `disabled` pair is a user exclusion and a
// `weak` pair is a PnP registration bridge, not verified geometry. Counting weak
// edges here would report a graph better-connected than the one SfM actually seeds
// from, which is precisely the lie this view exists to catch.

const WEAK_DEGREE = 2   // an image with fewer accepted edges than this is fragile

// Build health from match-store entries, but only once matching has produced a
// terminal result. With images loaded and no run yet, graphHealth([], imageIds)
// looks like a catastrophically split graph; null correctly means "not measured".
export function completedMatchGraphHealth(entries, imageIds) {
  const all = [...(entries || [])]
  if (!all.some((e) => e.status === 'done' || e.status === 'error')) return null
  const pairs = all
    .filter((e) => e.status === 'done' && e.inlierCount)
    .map((e) => ({
      idA: e.idA,
      idB: e.idB,
      inlierCount: e.inlierCount,
      weak: !!e.weak,
      disabled: !!e.disabled,
    }))
  return graphHealth(pairs, imageIds)
}

// pairs: [{ idA, idB, inlierCount, weak, disabled }] — plain, marshalled by caller.
// imageIds: string[] of every image uuid/id (so isolated images with no edge appear).
// → { components: [[id,…],…] (largest first), degrees: Map<id,number>,
//     isolated: [id], weaklyConnected: [{ id, degree }] (degree < WEAK_DEGREE, asc) }
export function graphHealth(pairs, imageIds) {
  const ids = [...new Set(imageIds || [])]
  const parent = new Map(ids.map((id) => [id, id]))
  const degrees = new Map(ids.map((id) => [id, 0]))

  function find(x) {
    if (!parent.has(x)) { parent.set(x, x); degrees.set(x, degrees.get(x) ?? 0) }
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n }
    return r
  }
  function union(a, b) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const p of pairs || []) {
    if (p.disabled || p.weak) continue     // accepted geometry only
    union(p.idA, p.idB)
    degrees.set(p.idA, (degrees.get(p.idA) ?? 0) + 1)
    degrees.set(p.idB, (degrees.get(p.idB) ?? 0) + 1)
  }

  // Group members by their component root.
  const byRoot = new Map()
  for (const id of parent.keys()) {
    const r = find(id)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r).push(id)
  }
  const components = [...byRoot.values()].sort((a, b) => b.length - a.length)

  const isolated = []
  const weaklyConnected = []
  for (const [id, d] of degrees) {
    if (d === 0) isolated.push(id)
    else if (d < WEAK_DEGREE) weaklyConnected.push({ id, degree: d })
  }
  weaklyConnected.sort((a, b) => a.degree - b.degree)

  // componentIndex: id → its component's rank (0 = largest). Lets a per-image row
  // say which component it fell in without re-running union-find in the caller.
  const componentIndex = new Map()
  components.forEach((comp, i) => { for (const id of comp) componentIndex.set(id, i) })

  const bridges = bridgeEdges(pairs, ids)

  return { components, componentIndex, degrees, isolated, weaklyConnected, bridges }
}

// Bridge (articulation) edges of the accepted-edge graph: an edge whose removal
// increases the component count — a "fragile link" whose failure would split the
// block. Found by iterative Tarjan low-link (iterative to survive thousand-image
// Antarctic blocks without blowing the JS stack). Returns
// [{ idA, idB, inlierCount }] sorted by inlierCount asc (weakest bridge first —
// the one most worth re-checking). weak/disabled edges are excluded, matching the
// connectivity graph above.
export function bridgeEdges(pairs, imageIds) {
  const ids = [...new Set(imageIds || [])]
  const adj = new Map(ids.map((id) => [id, []]))   // id → [{ to, inlierCount }]
  const seen = new Set()
  for (const p of pairs || []) {
    if (p.disabled || p.weak) continue
    if (!adj.has(p.idA)) adj.set(p.idA, [])
    if (!adj.has(p.idB)) adj.set(p.idB, [])
    const key = p.idA < p.idB ? p.idA + '\0' + p.idB : p.idB + '\0' + p.idA
    if (seen.has(key)) continue        // one edge per pair
    seen.add(key)
    adj.get(p.idA).push({ to: p.idB, inlierCount: p.inlierCount ?? 0 })
    adj.get(p.idB).push({ to: p.idA, inlierCount: p.inlierCount ?? 0 })
  }

  const disc = new Map(), low = new Map()
  let timer = 0
  const out = []

  for (const start of adj.keys()) {
    if (disc.has(start)) continue
    // Each stack frame: node, its parent, and an index into its adjacency list.
    const stack = [{ u: start, parent: null, i: 0 }]
    while (stack.length) {
      const fr = stack[stack.length - 1]
      const { u, parent } = fr
      if (fr.i === 0) { disc.set(u, timer); low.set(u, timer); timer++ }
      const nbrs = adj.get(u)
      if (fr.i < nbrs.length) {
        const { to: v } = nbrs[fr.i]
        fr.i++
        if (v === parent) { fr.parentSkipped = true; continue } // skip one parent edge
        if (!disc.has(v)) {
          stack.push({ u: v, parent: u, i: 0 })
        } else {
          low.set(u, Math.min(low.get(u), disc.get(v)))
        }
      } else {
        // Done with u: fold its low into parent and test the (parent,u) edge.
        stack.pop()
        if (parent != null) {
          low.set(parent, Math.min(low.get(parent), low.get(u)))
          if (low.get(u) > disc.get(parent)) {
            const inl = adj.get(u).find((e) => e.to === parent)?.inlierCount ?? 0
            out.push({ idA: parent, idB: u, inlierCount: inl })
          }
        }
      }
    }
  }
  out.sort((a, b) => a.inlierCount - b.inlierCount)
  return out
}
