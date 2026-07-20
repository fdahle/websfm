<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { estimateBatchFiducialLayout, validateFiducialCalibration } from '../../core/sfm/fiducialCalibration.js'
import { useSensorsStore } from '../../stores/useSensorsStore.js'

const props=defineProps({sensor:{type:Object,required:true},images:{type:Array,default:()=>[]}})
const emit=defineEmits(['close','detect'])
const sensorsStore=useSensorsStore()
const old=props.sensor.fiducialCalibration
const source=ref(old?.method==='batch'?'batch':'certificate'),transform=ref(old?.transform||'affine')
const focalMm=ref(old?.focalMm??props.sensor.fiducials?.focalMm??0),ppxMm=ref(old?.ppxMm??0),ppyMm=ref(old?.ppyMm??0)
const scanPitchMm=ref(old?.scanPitchMm??0.014),error=ref(''),report=ref(null)
const slots=computed(()=>[...new Set(props.images.flatMap(i=>(i.fiducialDetections||[]).map(d=>d.slot)))].sort())
const initialMarks=old?.marks?.length?old.marks:props.sensor.fiducials?.marks||[]
const marks=ref(initialMarks.length?initialMarks.map(m=>({...m})):slots.value.map((s,i)=>({id:`F${i+1}`,xMm:0,yMm:0})))
const slotMap=ref(Object.fromEntries(slots.value.map((s,i)=>[s,old?.slotMap?.[s]??marks.value[i]?.id??''])))
watch(marks,()=>{for(let i=0;i<slots.value.length;i++)if(!marks.value.some(m=>m.id===slotMap.value[slots.value[i]]))slotMap.value[slots.value[i]]=marks.value[i]?.id??''},{deep:true})
const detectedImages=computed(()=>props.images.filter(i=>(i.fiducialDetections?.length??0)>0))

function draft(){
  if(source.value==='batch'){
    const d=estimateBatchFiducialLayout(detectedImages.value,Number(scanPitchMm.value),{transform:transform.value,focalMm:Number(focalMm.value),ppxMm:Number(ppxMm.value),ppyMm:Number(ppyMm.value)})
    if(d){marks.value=d.marks.map(m=>({...m}));slotMap.value={...d.slotMap}}
    return d
  }
  return{version:1,method:'certificate',transform:transform.value,allowReflection:false,slotMap:{...slotMap.value},
    marks:marks.value.filter(m=>m.id&&Number.isFinite(Number(m.xMm))&&Number.isFinite(Number(m.yMm))).map(m=>({id:String(m.id),xMm:Number(m.xMm),yMm:Number(m.yMm)})),
    focalMm:Number(focalMm.value),ppxMm:Number(ppxMm.value),ppyMm:Number(ppyMm.value),scanPitchMm:null,fit:null}
}
function validate(){error.value='';const d=draft();if(!d){error.value='Need detections in at least three slots and a positive scan pitch';return null}if(!(d.focalMm>0)){error.value='Enter a positive calibrated focal length';return null}const mapped=Object.values(d.slotMap).filter(Boolean);if(new Set(mapped).size!==mapped.length){error.value='Each raster slot must map to a different certificate mark';return null}report.value=validateFiducialCalibration(detectedImages.value,d);return d}
function apply(){const d=validate();if(!d)return;if(!report.value.imageCount){error.value='Calibration could not be fitted on any image';return}d.fit={imageCount:report.value.imageCount,rmsUm:report.value.rmsUm,p95Um:report.value.p95Um,calibratedAt:new Date().toISOString()};sensorsStore.setFiducialCalibration(props.sensor.id,d);emit('close')}
function addMark(){marks.value.push({id:`F${marks.value.length+1}`,xMm:0,yMm:0})}
</script>

<template>
 <ModalShell title="Calibrate Fiducials" @close="emit('close')">
  <WarnBox v-if="!detectedImages.length">No accepted fiducial detections exist yet. <button class="link-btn" @click="emit('detect')">Detect fiducials first</button>.</WarnBox>
  <SettingsGroup title="Calibration source">
   <SettingsField label="Method" label-for="calMethod"><select id="calMethod" v-model="source" class="field-select"><option value="certificate">Camera certificate</option><option value="batch">Estimate from scans</option></select></SettingsField>
   <SettingsField label="Transform" label-for="calTransform" hint="Conformal preserves shape; Affine also models scanner shear; Projective needs at least four marks."><select id="calTransform" v-model="transform" class="field-select"><option value="conformal">Conformal</option><option value="affine">Affine</option><option value="projective">Projective</option></select></SettingsField>
   <SettingsField v-if="source==='batch'" label="Scan resolution" label-for="scanPitch" unit="mm/px" hint="Required to fix the metric scale of the estimated layout."><input id="scanPitch" v-model.number="scanPitchMm" type="number" step="any" min="0" class="field-input" /></SettingsField>
  </SettingsGroup>
  <SettingsGroup title="Camera calibration">
   <SettingsField label="Focal length" label-for="calFocal" unit="mm"><input id="calFocal" v-model.number="focalMm" type="number" step="any" class="field-input" /></SettingsField>
   <SettingsField label="Principal point X" label-for="calPpx" unit="mm"><input id="calPpx" v-model.number="ppxMm" type="number" step="any" class="field-input" /></SettingsField>
   <SettingsField label="Principal point Y" label-for="calPpy" unit="mm"><input id="calPpy" v-model.number="ppyMm" type="number" step="any" class="field-input" /></SettingsField>
  </SettingsGroup>
  <SettingsGroup v-if="source==='certificate'" title="Certificate marks and slot mapping">
   <table class="cal-table"><thead><tr><th>Certificate mark</th><th>X (mm)</th><th>Y (mm)</th></tr></thead><tbody>
    <tr v-for="m in marks" :key="m.id"><td><input v-model="m.id" class="field-input" /></td><td><input v-model.number="m.xMm" type="number" step="any" class="field-input" /></td><td><input v-model.number="m.yMm" type="number" step="any" class="field-input" /></td></tr>
   </tbody></table><button class="btn" @click="addMark">Add certificate mark</button>
   <table class="cal-table cal-map"><thead><tr><th>Raster slot</th><th>Certificate mark</th></tr></thead><tbody>
    <tr v-for="slot in slots" :key="slot"><td>{{slot}}</td><td><select v-model="slotMap[slot]" class="field-select"><option value="">Not mapped</option><option v-for="m in marks" :key="m.id" :value="m.id">{{m.id}}</option></select></td></tr>
   </tbody></table>
  </SettingsGroup>
  <WarnBox v-if="error">{{error}}</WarnBox>
  <SettingsGroup v-if="report" title="Validation"><p class="cal-hint">{{report.imageCount}} image(s) fit, {{report.failed}} failed · RMS {{report.rmsUm==null?'—':report.rmsUm.toFixed(1)}} µm · p95 {{report.p95Um==null?'—':report.p95Um.toFixed(1)}} µm</p></SettingsGroup>
  <template #footer><button class="btn" @click="emit('close')">Cancel</button><button class="btn" :disabled="!detectedImages.length" @click="validate">Validate</button><button class="btn btn-primary" :disabled="!detectedImages.length" @click="apply">Apply Calibration</button></template>
 </ModalShell>
</template>
<style scoped src="./ui/modal.css"></style><style scoped>.cal-table{width:100%;border-collapse:collapse;font-size:11px}.cal-table th,.cal-table td{padding:4px;border-bottom:1px solid var(--panel-border);text-align:left}.cal-map{margin-top:10px}.cal-hint{color:var(--text-dim);font-size:11px}.link-btn{border:0;background:none;color:var(--accent);cursor:pointer;padding:0}</style>
