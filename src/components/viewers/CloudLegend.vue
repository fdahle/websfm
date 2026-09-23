<script setup>
import { computed } from 'vue'
import { rampCss, groupCloudLegends } from '../../core/products/cloudStyle.js'
const props = defineProps({ layers: { type: Array, default: () => [] } })
const groups = computed(() => groupCloudLegends(props.layers))
const number = value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })
</script>
<template>
  <aside v-if="groups.length" class="cloud-legend" aria-label="Point cloud legend" @pointerdown.stop @wheel.stop>
    <h3>Legend</h3>
    <section v-for="layer in groups" :key="layer.id">
      <strong>{{ layer.legend.label }}</strong>
      <div class="legend-label" :title="layer.names.join('\n')">{{ layer.names.length === 1 ? layer.names[0] : `${layer.names.length} clouds` }}</div>
      <template v-if="layer.legend.entries">
        <div v-for="entry in layer.legend.entries.filter(e => e.visible)" :key="entry.value" class="legend-entry">
          <i :style="{ background: entry.colour }"></i><span>{{ entry.value }} · {{ entry.label }}</span>
        </div>
      </template>
      <template v-else-if="layer.legend.ramp">
        <div class="ramp" :style="{ background: rampCss(layer.legend.ramp) }"></div>
        <div class="legend-range"><span>{{ number(layer.legend.min) }}</span><span>{{ number(layer.legend.max) }}</span></div>
      </template>
      <div v-else-if="layer.legend.field === 'single'" class="legend-entry"><i :style="{ background: layer.legend.colour }"></i><span>All points</span></div>
    </section>
  </aside>
</template>
<style scoped>
.cloud-legend { position: absolute; right: 12px; top: 12px; width: 230px; max-width: calc(100% - 82px); max-height: calc(100% - 50px); overflow: auto; padding: 12px; background: color-mix(in srgb, var(--panel) 85%, transparent); border: 1px solid var(--panel-border); border-radius: 6px; color: var(--text); box-shadow: 0 3px 14px #0002; font-size: 11px; }
h3 { margin: 0 0 8px; font-size: 12px; }
section + section { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--panel-border); }
strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.legend-label { color: var(--text-dim); margin: 5px 0; }
.legend-entry { display: flex; gap: 8px; align-items: center; margin-top: 5px; }
i { width: 11px; height: 11px; border: 1px solid #8885; border-radius: 2px; flex-shrink: 0; }
.ramp { height: 10px; border-radius: 3px; margin-top: 6px; }
.legend-range { display: flex; justify-content: space-between; margin-top: 4px; font-variant-numeric: tabular-nums; }
</style>
