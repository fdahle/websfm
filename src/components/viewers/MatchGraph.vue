<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'

// Connected-Papers-style match graph: one node per image that appears in a verified
// pair, one edge per verified pair (thickness ∝ inlier count). Hand-rolled force
// layout on a canvas (no dependency), matching the ViewerMatch overlay style. Nodes
// are draggable; clicking an edge selects the pair (drives the preview), double-
// clicking an edge toggles its exclusion from reconstruction.
const props = defineProps({
  // From App.vue matchSummaries: { pairId, idAUuid, idBUuid, nameA, nameB,
  //   inlierCount, disabled }.
  matchSummaries: { type: Array,  default: () => [] },
  alignedUuids:   { type: Object, default: () => new Set() },
  hasSparse:      { type: Boolean, default: false },
  selectedPairId: { type: String, default: null },
})

const emit = defineEmits(['select', 'toggle-disabled'])

const canvasEl  = ref(null)
const wrapEl    = ref(null)
const hoverText = ref(null)  // { text, x, y }

let ctx = null
let nodes = []   // { uuid, name, x, y, vx, vy, aligned, deg }
let edges = []   // { a, b, pairId, inlierCount, disabled, w }
let nodeByUuid = new Map()
let topoKey = ''  // signature of the pair set; a change forces a full re-layout
let raf = null
let ticks = 0
let dragNode = null
let dragMoved = false
let W = 0, H = 0
const DPR = () => window.devicePixelRatio || 1

// ── Build graph from summaries ─────────────────────────────────────────────────
function build() {
  nodes = []
  edges = []
  nodeByUuid = new Map()
  const cx = W / 2, cy = H / 2

  const ensureNode = (uuid, name) => {
    let idx = nodeByUuid.get(uuid)
    if (idx == null) {
      idx = nodes.length
      // Seed on a circle so the layout unfolds cleanly rather than from a single point.
      const a = (idx * 2.399963)   // golden-angle scatter
      nodes.push({
        uuid, name,
        x: cx + Math.cos(a) * 120 + (Math.random() - 0.5) * 20,
        y: cy + Math.sin(a) * 120 + (Math.random() - 0.5) * 20,
        vx: 0, vy: 0,
        aligned: props.alignedUuids.has(uuid),
        deg: 0,
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
  topoKey = props.matchSummaries.map((m) => m.pairId).sort().join('|')
  ticks = 0
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

// Rebuild only when the topology changed; otherwise patch in place.
function sync() {
  if (pairSetKey() === topoKey) patch()
  else build()
}

// ── Force simulation ────────────────────────────────────────────────────────────
const REPULSE = 5200      // node-node repulsion strength
const SPRING  = 0.008     // edge spring constant
const REST    = 90        // spring rest length
const CENTER  = 0.002     // pull toward centre
const DAMP    = 0.86      // velocity damping
const MAX_TICKS = 480

function step() {
  const n = nodes.length
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]
      let dx = a.x - b.x, dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.25 }
      const f = REPULSE / d2
      const d = Math.sqrt(d2)
      const fx = (dx / d) * f, fy = (dy / d) * f
      a.vx += fx; a.vy += fy
      b.vx -= fx; b.vy -= fy
    }
  }
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
  for (const p of nodes) {
    if (p === dragNode) { p.vx = 0; p.vy = 0; continue }
    p.vx += (cx - p.x) * CENTER
    p.vy += (cy - p.y) * CENTER
    p.vx *= DAMP; p.vy *= DAMP
    p.x += p.vx; p.y += p.vy
  }
}

function loop() {
  if (ticks < MAX_TICKS && !dragNode) { step(); ticks++ }
  draw()
  raf = requestAnimationFrame(loop)
}

// ── Rendering ───────────────────────────────────────────────────────────────────
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
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
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
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2)
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

// ── Hit testing ─────────────────────────────────────────────────────────────────
function pos(e) {
  const r = canvasEl.value.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function nodeAt(x, y) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const p = nodes[i]
    if ((x - p.x) ** 2 + (y - p.y) ** 2 <= 100) return p
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
    const d = distToSeg(x, y, a.x, a.y, b.x, b.y)
    if (d < bestD) { bestD = d; best = e }
  }
  return best
}

// ── Interaction ─────────────────────────────────────────────────────────────────
function onDown(e) {
  const { x, y } = pos(e)
  const node = nodeAt(x, y)
  if (node) { dragNode = node; dragMoved = false }
}

function onMove(e) {
  const { x, y } = pos(e)
  if (dragNode) {
    dragNode.x = x; dragNode.y = y
    dragNode.vx = 0; dragNode.vy = 0
    dragMoved = true
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
    // A click without drag on a node isn't a selection target; just release.
    dragNode = null
    if (dragMoved) return
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

function onLeave() { dragNode = null; hoverText.value = null }

// ── Sizing / lifecycle ──────────────────────────────────────────────────────────
function resize() {
  const el = wrapEl.value
  if (!el || !canvasEl.value) return
  W = el.clientWidth; H = el.clientHeight
  const dpr = DPR()
  canvasEl.value.width = Math.round(W * dpr)
  canvasEl.value.height = Math.round(H * dpr)
  canvasEl.value.style.width = `${W}px`
  canvasEl.value.style.height = `${H}px`
}

let ro = null
onMounted(() => {
  ctx = canvasEl.value.getContext('2d')
  resize()
  build()
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
    />
    <div v-if="!matchSummaries.length" class="graph-empty">No verified pairs to graph.</div>
    <div v-if="hoverText" class="graph-hover" :style="{ left: hoverText.x + 12 + 'px', top: hoverText.y + 12 + 'px' }">
      {{ hoverText.text }}
    </div>
    <div class="graph-hint">Click an edge to preview · double-click to exclude/restore · drag nodes to arrange</div>
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
