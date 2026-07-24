<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

// Connected-Papers-style match graph: one node per image that appears in a verified
// pair, one edge per verified pair (thickness ∝ inlier count). Hand-rolled force
// layout on a canvas (no dependency), matching the ViewerMatch overlay style.
//
// Node coordinates live in a fixed "world" space; a pan/zoom view transform maps
// world → screen so the graph can be panned (drag empty space) and zoomed (wheel /
// buttons). The layout is pre-warmed to rest *before* the first paint so it opens
// settled rather than visibly drifting. When imported camera positions are available
// they can drive a geographic layout (nodes placed where the photos were taken).
//
// Nodes are draggable; clicking an edge selects the pair (drives the preview),
// double-clicking an edge toggles its exclusion from reconstruction. "Reset layout"
// recomputes the default arrangement, discarding any manual drags.
const props = defineProps({
  // From App.vue matchSummaries: { pairId, idAUuid, idBUuid, nameA, nameB,
  //   inlierCount, disabled }.
  matchSummaries: { type: Array,  default: () => [] },
  alignedUuids:   { type: Object, default: () => new Set() },
  hasSparse:      { type: Boolean, default: false },
  selectedPairId: { type: String, default: null },
  // Imported camera positions keyed by uuid ({ x, y } in project CRS). When present,
  // the geographic layout places those nodes at their real-world location.
  nodePositions:  { type: Object, default: () => ({}) },
})

const emit = defineEmits(['select', 'toggle-disabled'])

const canvasEl  = ref(null)
const wrapEl    = ref(null)
const hoverText = ref(null)  // { text, x, y }

// Layout mode: 'force' (spring layout) or 'geo' (imported camera positions). Only
// meaningful when positions exist; defaults to geo when they do.
const layoutMode  = ref('force')
const hasPositions = computed(() => Object.keys(props.nodePositions || {}).length > 0)

let ctx = null
let nodes = []   // { uuid, name, x, y, vx, vy, aligned, deg, pinned }
let edges = []   // { a, b, pairId, inlierCount, disabled, w }
let nodeByUuid = new Map()
let topoKey = ''  // signature of the pair set; a change forces a full re-layout
let raf = null
let settleFrames = 0   // remaining settle ticks to run inside the RAF loop (>0 ⇒ animating)
let settleTick = 0     // ticks done in the current animated settle (for the early-exit gate)
let dragNode = null
let dragMoved = false
let panning = false
let panMoved = false
let lastPan = { x: 0, y: 0 }
let W = 0, H = 0
// View transform: screen = world * scale + offset.
let scale = 1, ox = 0, oy = 0
const DPR = () => window.devicePixelRatio || 1

// ── World ⇄ screen ────────────────────────────────────────────────────────────
const sx = (wx) => wx * scale + ox
const sy = (wy) => wy * scale + oy
const wxFromScreen = (x) => (x - ox) / scale
const wyFromScreen = (y) => (y - oy) / scale

// ── Build graph from summaries ─────────────────────────────────────────────────
function build() {
  nodes = []
  edges = []
  nodeByUuid = new Map()

  const ensureNode = (uuid, name) => {
    let idx = nodeByUuid.get(uuid)
    if (idx == null) {
      idx = nodes.length
      nodes.push({
        uuid, name,
        x: 0, y: 0, vx: 0, vy: 0,
        aligned: props.alignedUuids.has(uuid),
        deg: 0,
        pinned: false,
      })
      nodeByUuid.set(uuid, idx)
    }
    return idx
  }

  let maxInliers = 1
  for (const m of props.matchSummaries) maxInliers = Math.max(maxInliers, m.inlierCount)

  for (const m of props.matchSummaries) {
    const a = ensureNode(m.idAUuid, m.nameA)
    const b = ensureNode(m.idBUuid, m.nameB)
    nodes[a].deg++; nodes[b].deg++
    edges.push({
      a, b,
      pairId: m.pairId,
      inlierCount: m.inlierCount,
      disabled: !!m.disabled,
      w: 0.8 + 3.2 * (m.inlierCount / maxInliers),  // 0.8–4 px
    })
  }
  topoKey = pairSetKey()
  seedPositions()
}

// Assign initial node coordinates for the current layout mode. Geographic mode pins
// nodes with a known camera position at their (y-flipped, screen-space normalised)
// location and seeds the rest near their pinned neighbours; force mode scatters all
// nodes on a golden-angle spiral so the spring layout unfolds cleanly.
function seedPositions() {
  const cx = W / 2, cy = H / 2
  const geo = layoutMode.value === 'geo' && hasPositions.value

  if (geo) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
    for (const p of nodes) {
      const pos = props.nodePositions[p.uuid]
      if (!pos) continue
      minx = Math.min(minx, pos.x); maxx = Math.max(maxx, pos.x)
      miny = Math.min(miny, pos.y); maxy = Math.max(maxy, pos.y)
    }
    const spanX = maxx - minx || 1, spanY = maxy - miny || 1
    // Fit the position cloud into 80% of the world box (fitView zooms it further).
    const s = Math.min((W * 0.8) / spanX, (H * 0.8) / spanY)
    for (const p of nodes) {
      const pos = props.nodePositions[p.uuid]
      if (pos) {
        // Flip northing so north is up (canvas y grows downward).
        p.x = (pos.x - minx) * s + W * 0.1
        p.y = (maxy - pos.y) * s + H * 0.1
        p.pinned = true
      } else {
        p.pinned = false
      }
      p.vx = 0; p.vy = 0
    }
    // Seed unpinned nodes near the centroid of their pinned neighbours.
    const acc = nodes.map(() => ({ x: 0, y: 0, n: 0 }))
    for (const e of edges) {
      const a = nodes[e.a], b = nodes[e.b]
      if (a.pinned && !b.pinned) { acc[e.b].x += a.x; acc[e.b].y += a.y; acc[e.b].n++ }
      if (b.pinned && !a.pinned) { acc[e.a].x += b.x; acc[e.a].y += b.y; acc[e.a].n++ }
    }
    nodes.forEach((p, i) => {
      if (p.pinned) return
      const s2 = acc[i]
      if (s2.n) { p.x = s2.x / s2.n + (Math.random() - 0.5) * 30; p.y = s2.y / s2.n + (Math.random() - 0.5) * 30 }
      else { p.x = cx + (Math.random() - 0.5) * 60; p.y = cy + (Math.random() - 0.5) * 60 }
    })
    return
  }

  nodes.forEach((p, idx) => {
    const a = idx * 2.399963   // golden-angle scatter
    p.x = cx + Math.cos(a) * 120 + (Math.random() - 0.5) * 20
    p.y = cy + Math.sin(a) * 120 + (Math.random() - 0.5) * 20
    p.vx = 0; p.vy = 0
    p.pinned = false
  })
}

// Signature of the pair set — unchanged when only per-pair flags (disabled) toggle.
function pairSetKey() {
  return props.matchSummaries.map((m) => m.pairId).sort().join('|')
}

// Patch mutable per-pair/-node state (disabled, aligned) without disturbing the
// existing layout — a full rebuild would jarringly re-scatter every node.
function patch() {
  const byPair = new Map(props.matchSummaries.map((m) => [m.pairId, m]))
  for (const e of edges) {
    const m = byPair.get(e.pairId)
    if (m) e.disabled = !!m.disabled
  }
  for (const p of nodes) p.aligned = props.alignedUuids.has(p.uuid)
}

// Rebuild + relayout when the topology changed; otherwise patch in place.
function sync() {
  if (pairSetKey() === topoKey) patch()
  else applyLayout()
}

// Full (re)layout: build the graph, settle it to rest, then fit it to the viewport.
// Used on first mount, topology change, mode switch, and "Reset layout".
// Small graphs settle synchronously (instant, static on open); large graphs settle
// across animation frames (see the RAF loop) so the main thread never blocks — the
// graph visibly unfolds instead of freezing the whole page.
function applyLayout() {
  build()
  if (nodes.length > GRID_THRESHOLD) {
    settleFrames = 200   // budget of ticks; the loop early-exits once it reaches rest
    settleTick = 0
    fitView()            // frame the seeded scatter; re-framed each settle frame
  } else {
    settleFrames = 0
    relax()
    fitView()
  }
}

// ── Force simulation ────────────────────────────────────────────────────────────
const REPULSE = 6400      // node-node repulsion strength (raised → less overlap)
const SPRING  = 0.008     // edge spring constant
const REST    = 100       // spring rest length
const CENTER  = 0.002     // pull toward centre
const DAMP    = 0.86      // velocity damping
const MAX_TICKS = 480

// Above this node count the exact O(n²) repulsion loop gets expensive enough to stall
// the main thread (a few hundred images × up to 200 settle ticks × heavy property
// access is already hundreds of millions of ops), so switch to a uniform-grid
// approximation AND settle over animation frames instead of synchronously (see
// applyLayout). Below it, keep the exact synchronous path — instant and identical for
// the common small-graph case. Kept low deliberately: for graphs this small every node
// is within the cutoff anyway, so the grid result matches the exact loop.
const GRID_THRESHOLD = 150
// Repulsion is REPULSE/d², negligible past a few rest-lengths; only pairs within this
// radius contribute meaningfully, so the grid can ignore everything farther. The
// centre pull (CENTER) still holds disconnected components together globally.
const REPULSE_CUTOFF = REST * 4   // 400px; f≈0.04 at the cutoff vs the spring's scale

// Exact all-pairs repulsion (O(n²)) — accurate, used for small graphs.
function repelExact(n) {
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < n; j++) {
      applyRepulsion(a, nodes[j])
    }
  }
}

// Grid-accelerated repulsion (~O(n·k)): bucket nodes into cells of the cutoff size,
// then only test each node against its own and the 8 neighbouring cells.
function repelGrid(n) {
  const cell = REPULSE_CUTOFF
  const cutoff2 = REPULSE_CUTOFF * REPULSE_CUTOFF
  const buckets = new Map()   // packed "gx,gy" key → array of node indices
  for (let i = 0; i < n; i++) {
    const p = nodes[i]
    const key = Math.floor(p.x / cell) + ',' + Math.floor(p.y / cell)
    let arr = buckets.get(key)
    if (!arr) { arr = []; buckets.set(key, arr) }
    arr.push(i)
  }
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    const gx = Math.floor(a.x / cell), gy = Math.floor(a.y / cell)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const arr = buckets.get((gx + ox) + ',' + (gy + oy))
        if (!arr) continue
        for (const j of arr) {
          if (j <= i) continue   // each unordered pair once (matches exact loop)
          const b = nodes[j]
          const dx = a.x - b.x, dy = a.y - b.y
          if (dx * dx + dy * dy > cutoff2) continue
          applyRepulsion(a, b)
        }
      }
    }
  }
}

// Symmetric repulsion between two nodes (shared by both paths).
function applyRepulsion(a, b) {
  let dx = a.x - b.x, dy = a.y - b.y
  let d2 = dx * dx + dy * dy
  if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.25 }
  const f = REPULSE / d2
  const d = Math.sqrt(d2)
  const fx = (dx / d) * f, fy = (dy / d) * f
  a.vx += fx; a.vy += fy
  b.vx -= fx; b.vy -= fy
}

// One integration step; returns total kinetic energy so relax() can detect rest.
function step() {
  const n = nodes.length
  if (n > GRID_THRESHOLD) repelGrid(n)
  else repelExact(n)
  for (const e of edges) {
    const a = nodes[e.a], b = nodes[e.b]
    const dx = b.x - a.x, dy = b.y - a.y
    const d = Math.hypot(dx, dy) || 0.01
    const f = SPRING * (d - REST)
    const fx = (dx / d) * f, fy = (dy / d) * f
    a.vx += fx; a.vy += fy
    b.vx -= fx; b.vy -= fy
  }
  const cx = W / 2, cy = H / 2
  let ke = 0
  for (const p of nodes) {
    // Pinned (geo) nodes and the one being dragged stay put.
    if (p === dragNode || p.pinned) { p.vx = 0; p.vy = 0; continue }
    p.vx += (cx - p.x) * CENTER
    p.vy += (cy - p.y) * CENTER
    p.vx *= DAMP; p.vy *= DAMP
    p.x += p.vx; p.y += p.vy
    ke += p.vx * p.vx + p.vy * p.vy
  }
  return ke
}

// Settle the layout to rest synchronously, so the graph appears static on open
// instead of animating into place. Early-exits once kinetic energy is negligible;
// keeps a lower cap for large graphs (step() is grid-accelerated but still linear).
function relax() {
  if (!nodes.length) return
  const cap = nodes.length > GRID_THRESHOLD ? 200 : MAX_TICKS
  for (let i = 0; i < cap; i++) {
    const ke = step()
    if (i > 30 && ke < 0.05 * nodes.length) break
  }
}

// ── View fitting ─────────────────────────────────────────────────────────────────
function nodeBounds() {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const p of nodes) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x)
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y)
  }
  return { minx, miny, maxx, maxy }
}

// Zoom/pan so the whole graph fits the viewport with padding.
function fitView() {
  if (!nodes.length) { scale = 1; ox = 0; oy = 0; return }
  const { minx, miny, maxx, maxy } = nodeBounds()
  const bw = maxx - minx || 1, bh = maxy - miny || 1
  const pad = 48
  scale = Math.max(0.05, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 3))
  ox = (W - bw * scale) / 2 - minx * scale
  oy = (H - bh * scale) / 2 - miny * scale
}

// Zoom about a screen point, keeping that point fixed under the cursor.
function zoomAt(x, y, factor) {
  const ns = Math.max(0.05, Math.min(scale * factor, 6))
  const wx = wxFromScreen(x), wy = wyFromScreen(y)
  scale = ns
  ox = x - wx * scale
  oy = y - wy * scale
}

function onWheel(e) {
  const { x, y } = pos(e)
  zoomAt(x, y, Math.exp(-e.deltaY * 0.0015))
}

function zoomButton(factor) { zoomAt(W / 2, H / 2, factor) }

// ── Rendering ───────────────────────────────────────────────────────────────────
function loop() {
  if (settleFrames > 0) advanceSettle()
  draw()
  raf = requestAnimationFrame(loop)
}

// Advance an animated (large-graph) settle by a few ticks per frame, re-framing as the
// layout expands, and stop once it reaches rest or exhausts its tick budget. Runs a
// small batch per frame so each frame stays short and the UI keeps responding.
function advanceSettle() {
  const TICKS_PER_FRAME = 6
  for (let k = 0; k < TICKS_PER_FRAME && settleFrames > 0; k++) {
    const ke = step()
    settleTick++
    settleFrames--
    if (settleTick > 30 && ke < 0.05 * nodes.length) { settleFrames = 0; break }
  }
  fitView()
}

function draw() {
  if (!ctx) return
  const dpr = DPR()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  // Edges
  for (const e of edges) {
    const a = nodes[e.a], b = nodes[e.b]
    const sel = e.pairId === props.selectedPairId
    ctx.beginPath()
    ctx.moveTo(sx(a.x), sy(a.y))
    ctx.lineTo(sx(b.x), sy(b.y))
    ctx.lineWidth = sel ? e.w + 1.5 : e.w
    if (e.disabled) {
      ctx.strokeStyle = sel ? 'rgba(240,80,80,0.9)' : 'rgba(150,150,150,0.4)'
      ctx.setLineDash([4, 4])
    } else {
      ctx.strokeStyle = sel ? '#f0a500' : 'rgba(120,180,120,0.45)'
      ctx.setLineDash([])
    }
    ctx.stroke()
  }
  ctx.setLineDash([])

  // Nodes
  for (const p of nodes) {
    ctx.beginPath()
    ctx.arc(sx(p.x), sy(p.y), 7, 0, Math.PI * 2)
    if (props.hasSparse && !p.aligned) {
      ctx.fillStyle = 'rgba(120,130,140,0.55)'  // unaligned: faded grey
    } else {
      ctx.fillStyle = '#0e639c'
    }
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#fff'
    ctx.stroke()
  }
}

// ── Hit testing (screen space) ────────────────────────────────────────────────────
function pos(e) {
  const r = canvasEl.value.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function nodeAt(x, y) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const p = nodes[i]
    if ((x - sx(p.x)) ** 2 + (y - sy(p.y)) ** 2 <= 100) return p
  }
  return null
}

// Distance from point to a segment, for edge hit-testing.
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy || 1e-6
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

function edgeAt(x, y) {
  let best = null, bestD = 6
  for (const e of edges) {
    const a = nodes[e.a], b = nodes[e.b]
    const d = distToSeg(x, y, sx(a.x), sy(a.y), sx(b.x), sy(b.y))
    if (d < bestD) { bestD = d; best = e }
  }
  return best
}

// ── Interaction ─────────────────────────────────────────────────────────────────
function onDown(e) {
  const { x, y } = pos(e)
  const node = nodeAt(x, y)
  if (node) { dragNode = node; dragMoved = false; return }
  // Empty space → pan.
  panning = true; panMoved = false; lastPan = { x, y }
}

function onMove(e) {
  const { x, y } = pos(e)
  if (dragNode) {
    dragNode.x = wxFromScreen(x); dragNode.y = wyFromScreen(y)
    dragNode.vx = 0; dragNode.vy = 0
    dragMoved = true
    return
  }
  if (panning) {
    ox += x - lastPan.x; oy += y - lastPan.y
    lastPan = { x, y }
    panMoved = true
    hoverText.value = null
    canvasEl.value.style.cursor = 'grabbing'
    return
  }
  // Hover label for nodes and edges.
  const node = nodeAt(x, y)
  if (node) {
    hoverText.value = { text: node.name + (props.hasSparse && !node.aligned ? ' (not aligned)' : ''), x, y }
    canvasEl.value.style.cursor = 'grab'
    return
  }
  const edge = edgeAt(x, y)
  if (edge) {
    const a = nodes[edge.a], b = nodes[edge.b]
    hoverText.value = { text: `${a.name} ↔ ${b.name} · ${edge.inlierCount} matches${edge.disabled ? ' · excluded' : ''}`, x, y }
    canvasEl.value.style.cursor = 'pointer'
  } else {
    hoverText.value = null
    canvasEl.value.style.cursor = 'default'
  }
}

function onUp(e) {
  if (dragNode) {
    dragNode = null
    if (dragMoved) return
  }
  if (panning) {
    panning = false
    canvasEl.value.style.cursor = 'default'
    if (panMoved) return   // a pan gesture, not a click
  }
  const { x, y } = pos(e)
  if (nodeAt(x, y)) return
  const edge = edgeAt(x, y)
  if (edge) emit('select', edge.pairId)
}

function onDblClick(e) {
  const { x, y } = pos(e)
  const edge = edgeAt(x, y)
  if (edge) emit('toggle-disabled', edge.pairId)
}

function onLeave() {
  dragNode = null; panning = false; hoverText.value = null
  if (canvasEl.value) canvasEl.value.style.cursor = 'default'
}

// ── Toolbar actions ───────────────────────────────────────────────────────────────
function setMode(mode) {
  if (layoutMode.value === mode) return
  layoutMode.value = mode
  applyLayout()
}

function resetLayout() { applyLayout() }

// ── Sizing / lifecycle ──────────────────────────────────────────────────────────
function resize() {
  const el = wrapEl.value
  if (!el || !canvasEl.value) return
  const prevW = W, prevH = H
  W = el.clientWidth; H = el.clientHeight
  const dpr = DPR()
  canvasEl.value.width = Math.round(W * dpr)
  canvasEl.value.height = Math.round(H * dpr)
  canvasEl.value.style.width = `${W}px`
  canvasEl.value.style.height = `${H}px`
  // Keep the graph framed after the first real size is known.
  if (!prevW && !prevH && nodes.length) fitView()
}

let ro = null
onMounted(() => {
  ctx = canvasEl.value.getContext('2d')
  resize()
  if (hasPositions.value) layoutMode.value = 'geo'
  applyLayout()
  ro = new ResizeObserver(() => resize())
  ro.observe(wrapEl.value)
  loop()
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  ro?.disconnect()
})

// Re-sync when summaries change: full re-layout on topology change, in-place patch
// when only flags (disabled/aligned) toggled.
watch(() => props.matchSummaries, () => sync(), { deep: true })
watch(() => props.alignedUuids, () => patch())
// Positions may arrive after the modal opens (poses import / restore); adopt a geo
// layout the first time they show up.
watch(hasPositions, (has) => {
  if (has && layoutMode.value === 'force') { layoutMode.value = 'geo'; applyLayout() }
})
</script>

<template>
  <div ref="wrapEl" class="graph-wrap">
    <canvas
      ref="canvasEl"
      class="graph-canvas"
      @mousedown="onDown"
      @mousemove="onMove"
      @mouseup="onUp"
      @mouseleave="onLeave"
      @dblclick="onDblClick"
      @wheel.prevent="onWheel"
    />

    <!-- Toolbar: layout mode, reset, zoom -->
    <div class="graph-toolbar">
      <div v-if="hasPositions" class="mode-toggle" title="Force = spring layout · Geographic = imported camera positions">
        <button class="mode-btn" :class="{ active: layoutMode === 'force' }" @click="setMode('force')">Force</button>
        <button class="mode-btn" :class="{ active: layoutMode === 'geo' }" @click="setMode('geo')">Geographic</button>
      </div>
      <button class="tool-btn" title="Reset layout (discard manual moves)" @click="resetLayout">Reset layout</button>
      <div class="zoom-group">
        <button class="tool-btn icon" title="Zoom in" @click="zoomButton(1.25)">+</button>
        <button class="tool-btn icon" title="Zoom out" @click="zoomButton(0.8)">−</button>
        <button class="tool-btn icon" title="Fit to view" @click="fitView">⤢</button>
      </div>
    </div>

    <div v-if="!matchSummaries.length" class="graph-empty">No verified pairs to graph.</div>
    <div v-if="hoverText" class="graph-hover" :style="{ left: hoverText.x + 12 + 'px', top: hoverText.y + 12 + 'px' }">
      {{ hoverText.text }}
    </div>
    <div class="graph-hint">Click edge to preview · double-click to exclude/restore · drag node to move · drag background to pan · scroll to zoom</div>
  </div>
</template>

<style scoped>
.graph-wrap {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--bg);
}

.graph-canvas { display: block; }

.graph-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-dim);
  font-style: italic;
}

/* Top-left controls */
.graph-toolbar {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  z-index: 3;
}

.mode-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  overflow: hidden;
}

.mode-btn {
  background: var(--panel);
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  padding: 3px 9px;
  cursor: pointer;
}
.mode-btn:hover { background: var(--hover-bg); color: var(--text); }
.mode-btn.active { background: var(--accent); color: #fff; }

.tool-btn {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  padding: 3px 9px;
  cursor: pointer;
}
.tool-btn:hover { background: var(--hover-bg); color: var(--text); }

.zoom-group {
  display: flex;
  gap: 4px;
}

.tool-btn.icon {
  width: 24px;
  padding: 3px 0;
  text-align: center;
  font-size: 13px;
  line-height: 1;
}

.graph-hover {
  position: absolute;
  padding: 3px 7px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}

.graph-hint {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-dim);
  pointer-events: none;
  white-space: nowrap;
}
</style>
