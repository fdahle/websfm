<script setup>
import { ref } from 'vue'
import ProductViewer from '/src/components/viewers/ProductViewer.vue'
import FindGcpsModal from '/src/components/modals/FindGcpsModal.vue'
import GradualSelectionModal from '/src/components/modals/GradualSelectionModal.vue'
import FootprintFromPosesModal from '/src/components/modals/FootprintFromPosesModal.vue'
import { useReconstructionStore } from '/src/stores/useReconstructionStore.js'
import { useExternalStore } from '/src/stores/useExternalStore.js'
import { useProjectsStore } from '/src/stores/useProjectsStore.js'
import { useImagesStore } from '/src/stores/useImagesStore.js'
import { useMeasurementsStore } from '/src/stores/useMeasurementsStore.js'
import { useGcpsStore } from '/src/stores/useGcpsStore.js'
import { usePosesStore } from '/src/stores/usePosesStore.js'
import { useFootprintsStore } from '/src/stores/useFootprintsStore.js'
const recon = useReconstructionStore(), external = useExternalStore(), projects = useProjectsStore(), images = useImagesStore(), gcps = useGcpsStore()
projects.persistenceAvailable = false
const open = ref(''), result = ref(null), raster = ref(null), viewer = ref(null)
const measurements = useMeasurementsStore(), poses = usePosesStore(), footprints = useFootprintsStore()
window.workflowTools = { recon, external, images, gcps, projects, measurements, poses, footprints, showRaster: id => { raster.value = external.rasterById(id) } }
// The raster tab's GCP pick, as useGcpEditing pickGcpFromReference runs it.
const selectedGcp = ref(null)
async function pickGcp(pick) {
  const res = await external.pickGroundControl(raster.value.id, pick.col, pick.row, pick)
  const id = pick.gcpId ?? gcps.addGcp()
  gcps.setGcpFromReference(id, res); selectedGcp.value = id
}
async function edit(request) { open.value = ''; result.value = await recon.editClouds(request) }
const footprintRun = ref(null)
async function runFootprints(settings) { open.value = ''; footprintRun.value = await footprints.computeFootprints(settings) }
</script>
<template>
  <button @click="open = 'gcps'">Find GCPs</button><button @click="open = 'gradual'">Gradual selection</button><button @click="open = 'footprints'">Footprints</button>
  <!-- Stand-in for the Ribbon's Measure group (App dispatches the same calls). -->
  <span role="toolbar" aria-label="Measure">
    <button v-for="t in ['length', 'area', 'profile', 'volume']" :key="t" :aria-pressed="viewer?.measureState?.tool === t" @click="viewer?.setMeasureTool(t)">measure-{{ t }}</button>
    <button :aria-pressed="!!viewer?.measureState?.showSaved" @click="viewer?.toggleSavedMeasurements()">measure-saved</button>
  </span>
  <div style="position:relative;width:800px;height:600px"><ProductViewer v-if="raster" ref="viewer" :kind="raster.kind" :product="raster" :source="external.sources.get(raster.id)" :selected-gcp="gcps.gcps.find(g => g.id === selectedGcp) ?? null" @pick-gcp="pickGcp" /><ProductViewer v-else-if="recon.dem" ref="viewer" kind="dem" :product="recon.dem" :frame-status="recon.productFrameStatus(recon.dem)" /></div>
  <FindGcpsModal v-if="open === 'gcps'" :has-relative-ortho="!!recon.ortho" :reference-orthos="external.orthoRasters" @close="open = ''" />
  <GradualSelectionModal v-if="open === 'gradual' && recon.mainSparseCloud" :cloud="recon.mainSparseCloud" @close="open = ''" @run="edit" />
  <FootprintFromPosesModal v-if="open === 'footprints'" :poses="poses.poses" :sensors="[]" :images="[]" :project-crs="projects.currentCrs" @close="open = ''" @run="runFootprints" />
  <output id="footprints">{{ footprintRun?.computed ?? '' }}</output>
  <output id="edited">{{ result?.points?.length ?? '' }}</output>
</template>
<style>
:root { --panel:#fff; --panel-border:#aaa; --accent:#1685ad; --text:#222; --bg:#fff; }
</style>
