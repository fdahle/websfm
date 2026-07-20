<script setup>
import { computed } from 'vue'
import StatTiles from '../ui/StatTiles.vue'
import DataTable from '../ui/DataTable.vue'
import { useMatchesStore } from '../../../stores/useMatchesStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { graphHealth } from '../../../core/eval/matchGraph.js'

// Quality Report ▸ Matching (WS2.3): connectivity of the accepted match graph, now
// with component MEMBERSHIP (which images fell in each component) and BRIDGE edges
// ("fragile links" whose failure would split the block). Weak/disabled pairs are
// excluded — the graph shown is the one SfM actually seeds from.
const emit = defineEmits(['open-match-list'])
const matchesStore = useMatchesStore()
const imagesStore = useImagesStore()

const nameByUuid = computed(() => new Map(imagesStore.images.map((im) => [im.uuid, im.name])))
const imageIds = computed(() => imagesStore.images.map((im) => im.uuid))
const nm = (uuid) => nameByUuid.value.get(uuid) ?? uuid

const pairs = computed(() => {
  const out = []
  for (const e of matchesStore.matchStore.values()) {
    if (e.status !== 'done' || !e.inlierCount) continue
    out.push({ idA: e.idA, idB: e.idB, inlierCount: e.inlierCount, weak: !!e.weak, disabled: !!e.disabled })
  }
  return out
})
const counts = computed(() => {
  let verified = 0, weak = 0, disabled = 0
  for (const p of pairs.value) { if (p.disabled) disabled++; else if (p.weak) weak++; else verified++ }
  return { verified, weak, disabled }
})
const health = computed(() => graphHealth(pairs.value, imageIds.value))

const tiles = computed(() => {
  const h = health.value
  const largest = h.components[0]?.length ?? 0
  return [
    { label: 'Components', value: h.components.length, tone: h.components.length > 1 ? 'warn' : 'ok',
      hint: h.components.length > 1 ? 'graph is split' : 'connected' },
    { label: 'Largest component', value: largest, hint: `of ${imageIds.value.length} images` },
    { label: 'Isolated', value: h.isolated.length, tone: h.isolated.length ? 'warn' : undefined },
    { label: 'Fragile links', value: h.bridges.length, tone: h.bridges.length ? 'warn' : undefined, hint: 'bridge edges' },
    { label: 'Verified pairs', value: counts.value.verified },
    { label: 'Weak pairs', value: counts.value.weak },
  ]
})

// Per-image rows with a component column.
const rows = computed(() =>
  imageIds.value.map((uuid) => ({
    id: uuid, name: nm(uuid),
    degree: health.value.degrees.get(uuid) ?? 0,
    component: (health.value.componentIndex.get(uuid) ?? 0) + 1,
  })),
)
const columns = [
  { key: 'name', label: 'Image' },
  { key: 'degree', label: 'Accepted edges', align: 'right' },
  { key: 'component', label: 'Component', align: 'right' },
]

// Components as an expandable list (largest first).
const componentList = computed(() => health.value.components.map((c, i) => ({
  id: i, rank: i + 1, size: c.length, names: c.map(nm),
})))
const bridges = computed(() => health.value.bridges.map((b, i) => ({ id: i, ...b, a: nm(b.idA), b2: nm(b.idB) })))
</script>

<template>
  <StatTiles :tiles="tiles" />

  <details class="grp" open>
    <summary>Components ({{ componentList.length }})</summary>
    <div class="comp-list">
      <div v-for="c in componentList" :key="c.id" class="comp">
        <div class="comp-head">#{{ c.rank }} <span class="comp-size">{{ c.size }} image{{ c.size === 1 ? '' : 's' }}</span></div>
        <div class="comp-names">{{ c.names.join(', ') }}</div>
      </div>
    </div>
  </details>

  <details v-if="bridges.length" class="grp">
    <summary>Fragile links ({{ bridges.length }})</summary>
    <div class="bridge-list">
      <div v-for="b in bridges" :key="b.id" class="bridge">
        <span class="bridge-pair">{{ b.a }} ↔ {{ b.b2 }}</span>
        <span class="bridge-inl">{{ b.inlierCount }} inliers</span>
      </div>
    </div>
    <p class="eval-note">A bridge pair failing would split the block — check the weakest ones.</p>
  </details>

  <DataTable :columns="columns" :rows="rows" sort-key="degree" sort-dir="asc" empty-text="No images." />
  <p class="eval-note">
    Sorted weakest-first. An image in a small or non-largest component often cannot register.
    <button class="link-btn" @click="emit('open-match-list')">Open match list →</button>
  </p>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-note { font-size: 11px; color: var(--text-dim); margin: 2px 0 0; line-height: 1.5; }
.grp { border: 1px solid var(--panel-border); border-radius: 8px; padding: 8px 12px; font-size: 12px; }
.grp summary { cursor: pointer; font-weight: 600; color: var(--text); }
.comp-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.comp-head { font-size: 12px; font-weight: 600; color: var(--text); }
.comp-size { font-weight: 400; color: var(--text-dim); }
.comp-names { font-size: 11px; color: var(--text-dim); line-height: 1.5; margin-top: 2px; }
.bridge-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.bridge { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.bridge-pair { color: var(--text); }
.bridge-inl { color: var(--text-dim); font-variant-numeric: tabular-nums; }
</style>
