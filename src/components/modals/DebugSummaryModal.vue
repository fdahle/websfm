<script setup>
// Debug ▸ Project Summary (PLAN-debug-summary). A compact, copy-pasteable digest of
// the whole project's reconstruction health — the same classified numbers the Quality
// Report hub shows, but small enough to paste into a chat/issue to answer "did this run
// succeed?" without wading through a multi-thousand-line log. Markdown for reading, JSON
// for precise parsing; the toggle lets the user choose. Read-only — computes once on
// open (async, for the GCP report) from useQualityReport().computeDigest.
import { ref, computed, onMounted } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import { useQualityReport } from '../../composables/useQualityReport.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { copyToClipboard } from '../../composables/useToasts.js'

const emit = defineEmits(['close'])

const report = useQualityReport()
const projects = useProjectsStore()

const format = ref('markdown')
const formatOptions = [
  { id: 'markdown', label: 'Markdown' },
  { id: 'json', label: 'JSON' },
]

const loading = ref(true)
const error = ref(null)
const markdown = ref('')
const json = ref('')

const text = computed(() => (format.value === 'json' ? json.value : markdown.value))

onMounted(async () => {
  try {
    const name = projects.currentProjectName ?? 'untitled'
    const out = await report.computeDigest(name)
    markdown.value = out.markdown
    json.value = out.json
  } catch (e) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
})

function copy() {
  copyToClipboard(text.value, `${format.value} summary`)
}
</script>

<template>
  <ModalShell title="Project Summary" aria-label="Project summary" @close="emit('close')">
    <p class="lede">
      A compact, classified digest of this project's reconstruction health — copy it to
      share a run's outcome without the full log. Same numbers as the Quality Report.
    </p>

    <div class="toolbar">
      <SegmentedControl v-model="format" :options="formatOptions" />
    </div>

    <div v-if="loading" class="state">Computing summary…</div>
    <div v-else-if="error" class="state err">Could not build summary: {{ error }}</div>
    <pre v-else class="digest">{{ text }}</pre>

    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
      <button class="btn btn-primary" :disabled="loading || !!error" @click="copy">Copy</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.lede { font-size: 12.5px; color: var(--text-dim); line-height: 1.55; margin: 0 0 14px; }
.toolbar { margin-bottom: 12px; }
.state { padding: 24px 0; text-align: center; color: var(--text-dim); font-size: 13px; }
.state.err { color: var(--danger, #e05252); }
.digest {
  margin: 0;
  padding: 12px 14px;
  max-height: 52vh;
  overflow: auto;
  background: var(--code-bg, var(--panel-border));
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre;
  tab-size: 2;
}
</style>
