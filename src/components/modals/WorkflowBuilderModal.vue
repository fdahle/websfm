<script setup>
import { computed, ref, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import {
  WORKFLOW_BLOCK_BY_ID, WORKFLOW_BLOCKS, WORKFLOW_CATEGORIES,
  blockOutputValid, createWorkflowBlock, updateWorkflowSetting, workflowPreflight, workflowRecipeText,
} from '../../core/workflow.js'

const props = defineProps({
  workflows: { type: Array, default: () => [] },
  activeId: { type: String, default: null },
  templates: { type: Array, default: () => [] },
  runs: { type: Array, default: () => [] },
  state: { type: Object, default: () => ({}) },
  running: { type: Boolean, default: false },
  pause: { type: Object, default: null },
  statuses: { type: Object, default: () => ({}) },
  currentBlockId: { type: String, default: null },
})
const emit = defineEmits([
  'close', 'set-active', 'add-workflow', 'update-workflow', 'duplicate-workflow',
  'remove-workflow', 'save-template', 'apply-template', 'remove-template',
  'run', 'respond', 'stop',
])

const activeBlockId = ref(null)
const paletteSearch = ref('')
const view = ref('visual')
const draggedId = ref(null)

const workflow = computed(() => props.workflows.find((w) => w.id === props.activeId) ?? props.workflows[0] ?? null)
const activeBlock = computed(() => workflow.value?.blocks.find((b) => b.id === activeBlockId.value) ?? null)
const activeSpec = computed(() => activeBlock.value ? WORKFLOW_BLOCK_BY_ID.get(activeBlock.value.type) : null)
const inspectorFields = computed(() => {
  const fields = activeSpec.value?.fields ?? []
  return workflow.value?.displayLevel === 'guided' ? fields.slice(0, 2) : fields
})
const checks = computed(() => workflow.value ? workflowPreflight(workflow.value, props.state) : [])
const errors = computed(() => checks.value.filter((x) => x.level === 'error'))
const visiblePalette = computed(() => WORKFLOW_BLOCKS.filter((b) => {
  const q = paletteSearch.value.trim().toLowerCase()
  return !q || b.label.toLowerCase().includes(q) || b.category.toLowerCase().includes(q)
}))
const recipeText = computed(() => workflow.value ? workflowRecipeText(workflow.value) : '')
const hasEnabledBlocks = computed(() => workflow.value?.blocks.some((block) => block.enabled) ?? false)

watch(workflow, (next) => {
  if (!next?.blocks.some((b) => b.id === activeBlockId.value)) activeBlockId.value = next?.blocks[0]?.id ?? null
}, { immediate: true })

function patchWorkflow(patch) {
  if (!workflow.value) return
  emit('update-workflow', { id: workflow.value.id, patch })
}
function patchBlock(id, patch) {
  const blocks = workflow.value.blocks.map((b) => b.id === id ? { ...b, ...patch } : b)
  patchWorkflow({ blocks })
}
function patchSetting(key, raw, type) {
  if (!activeBlock.value) return
  let value = raw
  if (type === 'number') value = raw === '' ? null : Number(raw)
  if (type === 'boolean') value = !!raw
  const settings = updateWorkflowSetting(activeBlock.value.settings, key, value)
  patchBlock(activeBlock.value.id, { settings })
}
function addBlock(type) {
  const block = createWorkflowBlock(type)
  patchWorkflow({ blocks: [...workflow.value.blocks, block] })
  activeBlockId.value = block.id
}
function removeBlock(id) {
  patchWorkflow({ blocks: workflow.value.blocks.filter((b) => b.id !== id) })
}
function duplicateBlock(id) {
  const index = workflow.value.blocks.findIndex((b) => b.id === id)
  if (index < 0) return
  const source = workflow.value.blocks[index]
  const copy = createWorkflowBlock(source.type)
  copy.settings = JSON.parse(JSON.stringify(source.settings))
  copy.reusePolicy = source.reusePolicy
  copy.warningPolicy = source.warningPolicy
  const blocks = [...workflow.value.blocks]
  blocks.splice(index + 1, 0, copy)
  patchWorkflow({ blocks })
  activeBlockId.value = copy.id
}
function moveBlock(fromId, toId) {
  if (!fromId || fromId === toId) return
  const blocks = [...workflow.value.blocks]
  const from = blocks.findIndex((b) => b.id === fromId), to = blocks.findIndex((b) => b.id === toId)
  if (from < 0 || to < 0) return
  const [item] = blocks.splice(from, 1)
  blocks.splice(to, 0, item)
  patchWorkflow({ blocks })
}
function onDrop(id) {
  moveBlock(draggedId.value, id)
  draggedId.value = null
}
function summary(block) {
  const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
  const fields = spec?.fields?.slice(0, workflow.value.displayLevel === 'guided' ? 2 : 4) ?? []
  const values = fields.map((f) => `${f.label}: ${formatValue(block.settings[f.key])}`)
  return values.join(' · ') || (spec?.automated ? 'Default settings' : 'Pauses for user input')
}
function plannedStatus(block) {
  const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
  if (!block.enabled) return 'Disabled'
  if (!spec?.automated) return 'Pause'
  if (!blockOutputValid(block.type, props.state)) return 'Run'
  const reuse = block.reusePolicy === 'inherit' ? workflow.value.defaults.reusePolicy : block.reusePolicy
  return reuse === 'valid' ? 'Reuse' : reuse === 'ask' ? 'Ask' : 'Rerun'
}
function formatValue(value) {
  if (value === true) return 'On'
  if (value === false) return 'Off'
  if (value == null || value === '') return 'Auto'
  return String(value)
}
async function copyRecipe() {
  await navigator.clipboard?.writeText(recipeText.value)
}
</script>

<template>
  <ModalShell title="Workflow Builder" aria-label="Workflow Builder" @close="emit('close')">
    <div v-if="workflow" class="builder">
      <header class="builder-toolbar">
        <label class="workflow-identity">
          <span class="field-label">Workflow name</span>
          <input class="field-input workflow-name" :value="workflow.name" :disabled="running"
            @change="patchWorkflow({ name: $event.target.value })" />
        </label>
        <label v-if="workflows.length > 1" class="workflow-switcher">
          <span class="field-label">Switch workflow</span>
          <select class="field-input field-select" :value="workflow.id" :disabled="running"
            @change="emit('set-active', $event.target.value)">
            <option v-for="item in workflows" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <div class="toolbar-actions">
          <button type="button" class="btn btn-compact" :disabled="running" @click="emit('add-workflow')">New</button>
          <button type="button" class="btn btn-compact" :disabled="running" @click="emit('duplicate-workflow', workflow.id)">Duplicate</button>
          <button type="button" class="btn btn-compact" :disabled="running" @click="emit('save-template', workflow.id)">Save template</button>
        </div>
        <button type="button" class="btn btn-compact danger-quiet" :disabled="workflows.length < 2 || running"
          @click="emit('remove-workflow', workflow.id)">Delete</button>
        <span class="toolbar-spacer"></span>
        <label class="detail-select">
          <span class="field-label">Settings</span>
          <select class="field-input" :value="workflow.displayLevel" :disabled="running" aria-label="Settings detail"
            @change="patchWorkflow({ displayLevel: $event.target.value })">
            <option value="guided">Guided</option>
            <option value="standard">Standard</option>
            <option value="expert">Expert</option>
          </select>
        </label>
        <div class="seg-row view-switcher" aria-label="Builder view">
          <button type="button" class="seg-btn" :class="{ active: view === 'visual' }" @click="view = 'visual'">Blocks</button>
          <button type="button" class="seg-btn" :class="{ active: view === 'recipe' }" @click="view = 'recipe'">Recipe</button>
        </div>
      </header>

      <div v-if="view === 'recipe'" class="recipe-pane">
        <span class="field-hint">Read-only preview of the blocks and settings in this workflow.</span>
        <textarea class="field-input" :value="recipeText" readonly spellcheck="false"></textarea>
        <button type="button" class="btn copy-button" @click="copyRecipe">Copy recipe</button>
      </div>

      <div v-else class="builder-grid">
        <aside class="palette">
          <h3>Blocks</h3>
          <input v-model="paletteSearch" class="field-input palette-search" type="search" placeholder="Find a command…" />
          <template v-for="category in WORKFLOW_CATEGORIES" :key="category">
            <section v-if="visiblePalette.some((b) => b.category === category)">
              <h4>{{ category }}</h4>
              <button v-for="block in visiblePalette.filter((b) => b.category === category)" :key="block.id"
                type="button" class="block-option" :disabled="running" @click="addBlock(block.id)">
                <span>{{ block.label }}</span><small>{{ block.automated ? 'Automatic' : 'Interactive' }}</small>
              </button>
            </section>
          </template>

          <section v-if="templates.length" class="templates">
            <h4>My templates</h4>
            <div v-for="item in templates" :key="item.id" class="template-row">
              <button type="button" class="btn template-name" @click="emit('apply-template', item.id)">{{ item.name }}</button>
              <button type="button" class="btn icon-button" title="Remove template" @click="emit('remove-template', item.id)">×</button>
            </div>
          </section>
          <section v-if="runs.length" class="runs">
            <h4>Recent runs</h4>
            <div v-for="run in runs.slice(0, 5)" :key="run.id" class="run-row">
              <span>{{ run.workflow?.name || 'Workflow' }}</span>
              <small :class="run.outcome">{{ run.outcome }}</small>
            </div>
          </section>
        </aside>

        <main class="workflow-lane">
          <div class="policy-row">
            <label><span class="field-label">Warnings</span>
              <select class="field-input field-select" :value="workflow.defaults.warningPolicy" :disabled="running"
                @change="patchWorkflow({ defaults: { ...workflow.defaults, warningPolicy: $event.target.value } })">
                <option value="pause">Pause and ask</option><option value="continue">Continue</option><option value="stop">Stop</option>
              </select>
            </label>
            <label><span class="field-label">Existing output</span>
              <select class="field-input field-select" :value="workflow.defaults.reusePolicy" :disabled="running"
                @change="patchWorkflow({ defaults: { ...workflow.defaults, reusePolicy: $event.target.value } })">
                <option value="valid">Reuse</option><option value="ask">Ask</option><option value="rerun">Always rerun</option>
              </select>
            </label>
          </div>

          <div v-if="!workflow.blocks.length" class="empty-lane">Add commands from the palette to build a workflow.</div>
          <article v-for="(block, index) in workflow.blocks" :key="block.id"
            class="workflow-block" :class="[{ selected: block.id === activeBlockId, disabled: !block.enabled }, statuses[block.id]?.status]"
            :draggable="!running" @dragstart="draggedId = block.id" @dragover.prevent @drop="onDrop(block.id)"
            @click="activeBlockId = block.id">
            <span class="drag" title="Drag to reorder">⠿</span>
            <span class="step">{{ index + 1 }}</span>
            <div class="block-copy">
              <strong>{{ WORKFLOW_BLOCK_BY_ID.get(block.type)?.label }}</strong>
              <small>{{ summary(block) }}</small>
            </div>
            <span v-if="!WORKFLOW_BLOCK_BY_ID.get(block.type)?.automated" class="badge">Interactive</span>
            <span class="status">{{ statuses[block.id]?.status || plannedStatus(block) }}</span>
            <button type="button" class="btn block-action" :disabled="running" :title="block.enabled ? 'Disable' : 'Enable'" @click.stop="patchBlock(block.id, { enabled: !block.enabled })">
              {{ block.enabled ? 'On' : 'Off' }}
            </button>
            <button type="button" class="btn icon-button" :disabled="running" title="Duplicate" @click.stop="duplicateBlock(block.id)">⧉</button>
            <button type="button" class="btn icon-button" :disabled="running" title="Remove" @click.stop="removeBlock(block.id)">×</button>
          </article>

          <section v-if="workflow.blocks.length" class="preflight">
            <h3>Preflight</h3>
            <p v-if="!checks.length" class="ok">Ready—dependencies are satisfied.</p>
            <p v-for="(item, index) in checks" :key="index" :class="item.level">{{ item.message }}</p>
          </section>
        </main>

        <aside class="inspector">
          <template v-if="activeBlock && activeSpec">
            <h3>{{ activeSpec.label }}</h3>
            <p>{{ activeSpec.automated ? 'Runs automatically.' : 'Opens the existing command and waits for you to finish.' }}</p>
            <template v-if="activeSpec.fields.length">
              <label v-for="field in inspectorFields" :key="field.key" class="field">
                <span class="field-label">{{ field.label }}</span>
                <select v-if="field.type === 'select'" class="field-input field-select" :disabled="running" :value="activeBlock.settings[field.key]"
                  @change="patchSetting(field.key, $event.target.value, field.type)">
                  <option v-for="option in field.options" :key="option" :value="option">{{ option }}</option>
                </select>
                <input v-else-if="field.type === 'number'" class="field-input" type="number" :disabled="running" :min="field.min" :max="field.max"
                  :value="activeBlock.settings[field.key]" @change="patchSetting(field.key, $event.target.value, field.type)" />
                <input v-else class="checkbox" type="checkbox" :disabled="running" :checked="activeBlock.settings[field.key]"
                  @change="patchSetting(field.key, $event.target.checked, field.type)" />
              </label>
            </template>
            <label class="field"><span class="field-label">Existing output</span>
              <select class="field-input field-select" :value="activeBlock.reusePolicy" :disabled="running" @change="patchBlock(activeBlock.id, { reusePolicy: $event.target.value })">
                <option value="inherit">Workflow default</option><option value="valid">Reuse</option>
                <option value="ask">Ask</option><option value="rerun">Always rerun</option>
              </select>
            </label>
            <label class="field"><span class="field-label">Warnings</span>
              <select class="field-input field-select" :value="activeBlock.warningPolicy" :disabled="running" @change="patchBlock(activeBlock.id, { warningPolicy: $event.target.value })">
                <option value="inherit">Workflow default</option><option value="pause">Pause and ask</option>
                <option value="continue">Continue</option><option value="stop">Stop</option>
              </select>
            </label>
            <details v-if="workflow.displayLevel === 'expert'">
              <summary>All settings</summary>
              <pre>{{ JSON.stringify(activeBlock.settings, null, 2) }}</pre>
            </details>
          </template>
          <p v-else>Select a block to edit it.</p>
        </aside>
      </div>

      <div v-if="pause" class="pause-banner" :class="pause.kind">
        <strong>{{ pause.kind === 'interactive' ? 'Waiting for you' : pause.kind === 'reuse' ? 'Reuse existing output?' : 'Workflow paused' }}</strong>
        <span>{{ pause.message }}</span>
        <template v-if="pause.kind === 'reuse'">
          <button type="button" class="btn" @click="emit('respond', 'reuse')">Reuse</button>
          <button type="button" class="btn btn-primary" @click="emit('respond', 'rerun')">Rerun</button>
          <button type="button" class="btn" @click="emit('respond', 'stop')">Stop</button>
        </template>
        <template v-else-if="pause.kind === 'interactive'">
          <button type="button" class="btn btn-primary" @click="emit('respond', 'continue')">Mark complete &amp; continue</button>
          <button type="button" class="btn" @click="emit('respond', 'stop')">Stop</button>
        </template>
        <template v-else-if="pause.kind === 'warning'">
          <button type="button" class="btn btn-primary" @click="emit('respond', 'continue')">Continue</button>
          <button type="button" class="btn" @click="emit('respond', 'stop')">Stop</button>
        </template>
        <template v-else-if="pause.kind === 'blocked'">
          <button type="button" class="btn" @click="emit('respond', 'dismiss')">Dismiss</button>
        </template>
      </div>
    </div>

    <template #footer>
      <span v-if="errors.length" class="footer-error">{{ errors.length }} dependency problem{{ errors.length === 1 ? '' : 's' }}</span>
      <span class="footer-spacer"></span>
      <button v-if="running" type="button" class="btn danger" @click="emit('stop')">Stop workflow</button>
      <button v-else type="button" class="btn" @click="emit('close')">Close</button>
      <button v-if="!running && activeBlock" type="button" class="btn" :disabled="!!errors.length"
        @click="emit('run', { workflow, fromIndex: workflow.blocks.findIndex((b) => b.id === activeBlock.id) })">Run from selected</button>
      <button v-if="!running && activeBlock" type="button" class="btn"
        @click="emit('run', { workflow, fromIndex: 0, onlyIds: [activeBlock.id] })">Run selected</button>
      <button v-if="!running" type="button" class="btn btn-primary" :disabled="!workflow || !hasEnabledBlocks || !!errors.length"
        @click="emit('run', { workflow, fromIndex: 0 })">Run workflow</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
:deep(.modal) { width: min(1380px, 94vw); height: min(860px, 92vh); }
:deep(.modal-body) { padding: 0; overflow: hidden; }
.builder { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.builder-toolbar { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-bottom: 1px solid var(--panel-border); }
.workflow-identity, .workflow-switcher, .detail-select { display: flex; flex-direction: column; gap: 4px; }
.workflow-name { width: 210px; font-weight: 600; }
.workflow-switcher .field-select { max-width: 190px; }
.detail-select .field-input { width: 105px; }
.toolbar-actions, .view-switcher { display: flex; gap: 4px; }
.toolbar-spacer, .footer-spacer { flex: 1; }
.btn-compact { padding: 4px 9px; }
.view-switcher { flex-wrap: nowrap; }
.view-switcher .seg-btn { white-space: nowrap; }
.builder-grid { min-height: 0; flex: 1; display: grid; grid-template-columns: 230px minmax(440px, 1fr) 300px; }
.palette, .inspector { overflow: auto; padding: 14px; background: var(--panel); }
.palette { border-right: 1px solid var(--panel-border); }
.inspector { border-left: 1px solid var(--panel-border); }
h3 { margin: 0 0 10px; font-size: 13px; }
h4 { margin: 16px 0 6px; color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.palette-search { width: 100%; box-sizing: border-box; }
.block-option { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; margin: 4px 0; padding: 7px 8px; background: var(--bg); border: 1px solid var(--panel-border); border-radius: 5px; color: var(--text); font: inherit; cursor: pointer; }
.block-option:hover:not(:disabled) { border-color: var(--text-dim); background: var(--hover-bg); }
.block-option:disabled { opacity: .4; cursor: default; }
.palette small { color: var(--text-dim); }
.template-row { display: grid; grid-template-columns: 1fr auto; gap: 4px; margin-bottom: 4px; }
.template-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; text-align: left; }
.icon-button { width: 29px; padding: 4px; }
.run-row { display: flex; justify-content: space-between; gap: 6px; padding: 4px 2px; }
.run-row small.completed { color: #36a269; }
.run-row small.failed { color: #d35353; }
.workflow-lane { overflow: auto; padding: 14px 18px 40px; background: var(--bg); }
.policy-row { display: flex; gap: 18px; padding: 10px 12px; margin-bottom: 12px; background: var(--panel); border: 1px solid var(--panel-border); border-radius: 7px; }
.policy-row label { display: flex; align-items: center; gap: 8px; }
.workflow-block { display: flex; align-items: center; gap: 9px; margin: 7px 0; padding: 10px; border: 1px solid var(--panel-border); border-radius: 7px; background: var(--panel); cursor: pointer; }
.workflow-block:hover { border-color: var(--text-dim); }
.workflow-block.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.workflow-block.disabled { opacity: .55; }
.workflow-block.running { border-color: var(--accent); }
.workflow-block.completed, .workflow-block.reused { border-left: 4px solid #36a269; }
.workflow-block.failed { border-left: 4px solid #d35353; }
.drag { cursor: grab; color: var(--text-dim); }
.step { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: var(--hover-bg); font-size: 11px; }
.block-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.block-copy small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-dim); }
.badge, .status { font-size: 11px; padding: 2px 6px; border-radius: 10px; background: var(--hover-bg); }
.block-action { padding: 4px 7px; }
.inspector .field { margin: 12px 0; }
.inspector .field-input { width: 100%; box-sizing: border-box; }
.inspector input[type="checkbox"] { justify-self: start; width: 14px; }
.inspector pre { max-height: 260px; overflow: auto; padding: 8px; border-radius: 5px; background: var(--bg); font-size: 11px; }
.preflight { margin-top: 18px; border-top: 1px solid var(--panel-border); padding-top: 12px; }
.preflight p { margin: 5px 0; font-size: 12px; }
.preflight .ok { color: #36a269; }
.preflight .error, .footer-error { color: #d35353; }
.preflight .warning { color: #d49a25; }
.preflight .info { color: var(--text-dim); }
.pause-banner { display: flex; gap: 10px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--panel-border); background: var(--hover-bg); }
.pause-banner span { flex: 1; }
.recipe-pane { flex: 1; min-height: 0; padding: 18px; display: flex; flex-direction: column; gap: 10px; background: var(--bg); }
.recipe-pane textarea { width: 100%; box-sizing: border-box; flex: 1; resize: none; font-family: ui-monospace, monospace; }
.copy-button { align-self: flex-end; }
.empty-lane { padding: 48px 24px; text-align: center; color: var(--text-dim); background: var(--panel); border: 1px dashed var(--panel-border); border-radius: 7px; }
.danger-quiet, .danger { color: #d35353; }
.footer-error { align-self: center; }
@media (max-width: 1120px) {
  .builder-toolbar { flex-wrap: wrap; }
  .toolbar-spacer { display: none; }
  .builder-grid { grid-template-columns: 200px 1fr; }
  .inspector { display: none; }
}
</style>
