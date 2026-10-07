<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { TERRAIN_DEFAULTS } from '../../core/defaults.user.js'

// Slope, Aspect, Hillshade (Tools ▸ Products ▾) — terrain derivatives of the DEM
// (Horn's method, as gdaldem; core/products/terrain.js), each downloaded as a
// GeoTIFF on the DEM's grid. Slope compares a height difference with a horizontal
// one, so both must be in the same unit: true for a metric or model-unit DEM; a
// projected CRS's scale factor k is corrected at the DEM centre.
const props = defineProps({
  dem: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...TERRAIN_DEFAULTS, products: [...TERRAIN_DEFAULTS.products], compression: 'deflate' })
const PRODUCTS = [
  { id: 'slope', label: 'Slope' },
  { id: 'aspect', label: 'Aspect (degrees clockwise from north)' },
  { id: 'hillshade', label: 'Hillshade' },
]
const has = (id) => settings.value.products.includes(id)
function toggle(id) {
  const on = has(id)
  settings.value.products = PRODUCTS.filter((p) => (p.id === id ? !on : has(p.id))).map((p) => p.id)
}
const geographic = computed(() => /longlat|EPSG:4326\b/i.test(props.dem?.crs || ''))

function run() {
  const s = settings.value
  emit('run', {
    products: [...s.products], slopeUnits: s.slopeUnits, azimuth: s.azimuth, altitude: s.altitude,
    multidirectional: !!s.multidirectional, compression: s.compression,
  })
}
</script>

<template>
  <ModalShell title="Slope, Aspect, Hillshade" @close="emit('close')">
    <WarnBox v-if="!dem">Build a DEM first (<strong>Reconstruct ▸ DEM</strong>).</WarnBox>
    <WarnBox v-else-if="geographic">This DEM is in degrees of longitude/latitude, so its horizontal and vertical units differ. Rebuild it in a projected CRS for slope and aspect.</WarnBox>
    <template v-else>
      <SettingsGroup title="Rasters">
        <SettingsField hint="Each is a separate GeoTIFF on the DEM's grid and CRS.">
          <label v-for="p in PRODUCTS" :key="p.id" class="checkbox-row">
            <input type="checkbox" class="checkbox" :checked="has(p.id)" @change="toggle(p.id)" /> {{ p.label }}
          </label>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup v-if="has('slope')" title="Slope">
        <SettingsField label="Units" label-for="tr-units">
          <select id="tr-units" v-model="settings.slopeUnits" class="field-select">
            <option value="degrees">Degrees</option>
            <option value="percent">Percent (rise / run × 100)</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup v-if="has('hillshade')" title="Hillshade">
        <SettingsField label="Sun azimuth" label-for="tr-az" unit="°" hint="315 = from the north-west, the cartographic convention.">
          <input id="tr-az" v-model.number="settings.azimuth" type="number" min="0" max="360" step="5" class="field-input" />
        </SettingsField>
        <SettingsField label="Sun altitude" label-for="tr-alt" unit="°">
          <input id="tr-alt" v-model.number="settings.altitude" type="number" min="1" max="90" step="5" class="field-input" />
        </SettingsField>
        <SettingsField hint="Blends four sun directions, so no slope disappears into shadow.">
          <label class="checkbox-row"><input v-model="settings.multidirectional" type="checkbox" class="checkbox" /> Multidirectional</label>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="File">
        <SettingsField label="Compression" label-for="tr-comp">
          <select id="tr-comp" v-model="settings.compression" class="field-select">
            <option value="deflate">DEFLATE</option>
            <option value="none">None</option>
          </select>
        </SettingsField>
      </SettingsGroup>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!dem || geographic || !settings.products.length" @click="run">Export</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
