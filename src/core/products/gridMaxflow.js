// Minimum s-t cut on a 4-connected grid: Boykov & Kolmogorov (2004), "An experimental
// comparison of min-cut/max-flow algorithms for energy minimization in vision" — two
// search trees grown from the terminals, augmenting paths found where they touch, and
// orphans re-adopted instead of growing the trees from scratch. Pure, typed arrays.
//
// The graph is a w × h grid inside a one-cell ring of isolated nodes, so a node's four
// neighbours always exist and no arc needs a bounds test. Arc d of node i: 0 → i + 1,
// 1 → i − 1, 2 → i + W, 3 → i − W (W = w + 2); its reverse is arc d ^ 1 of the neighbour.
// Capacities are residual and should be integers (exact arithmetic, so the result does
// not depend on the order flow was pushed in). `tr[i]` is node i's terminal capacity,
// source minus sink: the cut pays tr[i] when i ends on the sink side if tr[i] > 0, and
// −tr[i] when it ends on the source side if tr[i] < 0.

const NONE = -1, TERMINAL = 4, ORPHAN = 5

export function createGridGraph(w, h) {
  const W = w + 2, n = W * (h + 2)
  return {
    w, h, W, n,
    cap: new Float64Array(4 * n), tr: new Float64Array(n),
    // Search state, kept for reuse between solves of the same size.
    parent: new Int8Array(n), isSink: new Uint8Array(n), ts: new Int32Array(n), dist: new Int32Array(n),
    nextActive: new Int32Array(n), orphans: new Int32Array(n),
  }
}

// The node of grid cell (c, r), 0-based inside the ring.
export const gridNode = (g, c, r) => (r + 1) * g.W + c + 1

// Zero every capacity, for the next problem on the same graph.
export function resetGridGraph(g) { g.cap.fill(0); g.tr.fill(0) }

// Max flow; afterwards inSinkSet(g, i) says which side of the minimum cut node i is on
// (nodes reachable from neither terminal are on the source side). Returns the flow.
export function gridMaxflow(g) {
  const { cap, tr, parent, isSink, ts, dist, nextActive, orphans, n, W } = g
  const off = [1, -1, W, -W]
  let flow = 0, time = 0
  // Active queue: a FIFO threaded through nextActive (−2 = not queued, −1 = last).
  let first = -1, last = -1
  const activate = (i) => {
    if (nextActive[i] !== -2) return
    nextActive[i] = -1
    if (last >= 0) nextActive[last] = i; else first = i
    last = i
  }
  const popActive = () => {
    const i = first
    if (i < 0) return -1
    first = nextActive[i]
    if (first < 0) last = -1
    nextActive[i] = -2
    return i
  }
  // Orphans: a ring buffer (a node is queued at most once per adoption phase).
  let oHead = 0, oCount = 0
  const orphan = (i) => { parent[i] = ORPHAN; orphans[(oHead + oCount++) % n] = i }

  for (let i = 0; i < n; i++) {
    nextActive[i] = -2; ts[i] = 0; dist[i] = 0
    if (tr[i] > 0) { parent[i] = TERMINAL; isSink[i] = 0; dist[i] = 1; activate(i) }
    else if (tr[i] < 0) { parent[i] = TERMINAL; isSink[i] = 1; dist[i] = 1; activate(i) }
    else { parent[i] = NONE; isSink[i] = 0 }
  }

  let current = -1
  for (;;) {
    let i = current
    if (i >= 0 && parent[i] === NONE) i = -1
    if (i < 0) {
      do { i = popActive() } while (i >= 0 && parent[i] === NONE)
      if (i < 0) break
    }
    // Grow the tree of i; stop at the first arc into the other tree.
    let mu = -1, md = -1 // the middle arc, from its source-tree end mu in direction md
    if (!isSink[i]) {
      for (let d = 0; d < 4; d++) {
        if (!(cap[4 * i + d] > 0)) continue
        const j = i + off[d]
        if (parent[j] === NONE) {
          isSink[j] = 0; parent[j] = d ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; activate(j)
        } else if (isSink[j]) { mu = i; md = d; break }
        else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = d ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1 }
      }
    } else {
      for (let d = 0; d < 4; d++) {
        const j = i + off[d]
        if (!(cap[4 * j + (d ^ 1)] > 0)) continue
        if (parent[j] === NONE) {
          isSink[j] = 1; parent[j] = d ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; activate(j)
        } else if (!isSink[j]) { mu = j; md = d ^ 1; break }
        else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = d ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1 }
      }
    }
    time++
    if (mu < 0) { current = -1; continue }
    current = i

    // Augment along source … mu → mv … sink by the path's bottleneck.
    const mv = mu + off[md]
    let b = cap[4 * mu + md], x = mu
    for (;;) {
      const p = parent[x]
      if (p === TERMINAL) break
      const y = x + off[p], c = cap[4 * y + (p ^ 1)]
      if (c < b) b = c
      x = y
    }
    if (tr[x] < b) b = tr[x]
    x = mv
    for (;;) {
      const p = parent[x]
      if (p === TERMINAL) break
      const c = cap[4 * x + p]
      if (c < b) b = c
      x += off[p]
    }
    if (-tr[x] < b) b = -tr[x]
    cap[4 * mu + md] -= b; cap[4 * mv + (md ^ 1)] += b
    for (x = mu; ;) {
      const p = parent[x]
      if (p === TERMINAL) { tr[x] -= b; if (!tr[x]) orphan(x); break }
      const y = x + off[p]
      cap[4 * y + (p ^ 1)] -= b; cap[4 * x + p] += b
      if (!cap[4 * y + (p ^ 1)]) orphan(x)
      x = y
    }
    for (x = mv; ;) {
      const p = parent[x]
      if (p === TERMINAL) { tr[x] += b; if (!tr[x]) orphan(x); break }
      const y = x + off[p]
      cap[4 * x + p] -= b; cap[4 * y + (p ^ 1)] += b
      if (!cap[4 * x + p]) orphan(x)
      x = y
    }
    flow += b

    // Adoption: give each orphan a parent of its own tree whose path still reaches the
    // terminal (the shortest such), or free it and orphan its children.
    time++
    while (oCount) {
      const o = orphans[oHead]; oHead = (oHead + 1) % n; oCount--
      const sink = isSink[o]
      let best = -1, dmin = Infinity
      for (let d = 0; d < 4; d++) {
        const j = o + off[d]
        if (isSink[j] !== sink || parent[j] === NONE) continue
        if (!(sink ? cap[4 * o + d] > 0 : cap[4 * j + (d ^ 1)] > 0)) continue
        // Does j's path still reach the terminal? Count its length on the way.
        let dd = 0, y = j
        for (;;) {
          if (ts[y] === time) { dd += dist[y]; break }
          const p = parent[y]
          dd++
          if (p === TERMINAL) { ts[y] = time; dist[y] = 1; break }
          if (p === ORPHAN) { dd = Infinity; break }
          y += off[p]
        }
        if (dd === Infinity) continue
        if (dd < dmin) { best = d; dmin = dd }
        for (y = j; ts[y] !== time; y += off[parent[y]]) { ts[y] = time; dist[y] = dd--; }
      }
      if (best >= 0) { parent[o] = best; ts[o] = time; dist[o] = dmin + 1; continue }
      // No parent: o leaves its tree. Neighbours that could reach it become active,
      // and its own children become orphans.
      for (let d = 0; d < 4; d++) {
        const j = o + off[d], p = parent[j]
        if (isSink[j] !== sink || p === NONE) continue
        if (sink ? cap[4 * o + d] > 0 : cap[4 * j + (d ^ 1)] > 0) activate(j)
        if (p !== TERMINAL && p !== ORPHAN && j + off[p] === o) orphan(j)
      }
      parent[o] = NONE
    }
  }
  return flow
}

export const inSinkSet = (g, i) => g.parent[i] !== NONE && g.isSink[i] === 1
