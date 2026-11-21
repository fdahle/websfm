<script setup>
// Debug ▸ Flags: the internal tuning values (core/tuning.js) the console's `set` reaches,
// as a registry-style dialog. A tree of the groups (and the sections tuning.js marks with
// `// ── … ──`) on the left, a table of the selected group's values on the right, and the
// help of the selected value under it: the first paragraph of its comment in tuning.js,
// read from the file itself (core/tuningHelp.js), so the help is the code's own; the
// evidence below that paragraph stays in the code. Every change goes through the one
// store the console uses (stores/tuningOverrides.js), which logs it on the Activity channel
// with the `set` command that makes it. User-facing defaults (defaults.user.js) are not
// here: those are the dialogs' settings.
import { ref, reactive, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import tuningSource from '../../../core/tuning.js?raw'
import { parseTuningHelp, helpParagraphs } from '../../../core/tuningHelp.js'
import {
  TUNING_GROUPS,
  tuningEntries,
  getPath,
  parseTuningValue,
  checkTuningValue,
} from '../../../core/help/consoleSettings.js'
import {
  tuningOverrides,
  changedFlags,
  flagCount,
  keepFlags,
  editFlag,
  resetAllFlags,
  setKeepFlags,
} from '../../../stores/tuningOverrides.js'
import { askConfirm } from '../../../composables/useConfirmations.js'
import { useI18n } from '../../../composables/useI18n.js'

const emit = defineEmits(['close'])
const { t } = useI18n()

const HELP = parseTuningHelp(tuningSource)
const GROUP_IDS = Object.keys(TUNING_GROUPS)

// Every knob, with its help and section from tuning.js.
const ENTRIES = tuningEntries().map((e) => {
  const doc = HELP[TUNING_GROUPS[e.group].exportName]?.keys?.[e.path.join('.')] ?? null
  return {
    ...e,
    help: doc?.help ?? '',
    section: doc?.section ?? null,
    sharedWith: doc?.sharedWith ? `${e.group}.${doc.sharedWith}` : null,
    search: `${e.key}\n${doc?.help ?? ''}`.toLowerCase(),
  }
})
const BY_KEY = new Map(ENTRIES.map((e) => [e.key, e]))

// The tree: each group, then its sections in tuning.js order (keys before the first
// section title sit under the group alone).
const TREE = GROUP_IDS.map((group) => {
  const sections = []
  for (const e of ENTRIES) if (e.group === group && e.section && !sections.includes(e.section)) sections.push(e.section)
  return { group, sections }
})

const selected = ref({ group: GROUP_IDS[0], section: null })
const query = ref('')
const activeKey = ref(null)

const changedSet = computed(() => new Set(changedFlags.value.map((c) => c.key)))
const changedIn = (group, section = null) =>
  ENTRIES.filter((e) => e.group === group && (section == null || e.section === section) && changedSet.value.has(e.key))
    .length

const searching = computed(() => query.value.trim().length > 0)
const rows = computed(() => {
  if (searching.value) {
    const words = query.value.trim().toLowerCase().split(/\s+/)
    return ENTRIES.filter((e) => words.every((w) => e.search.includes(w)))
  }
  const { group, section } = selected.value
  return ENTRIES.filter((e) => e.group === group && (section == null || e.section === section))
})

function selectNode(group, section = null) {
  selected.value = { group, section }
  query.value = ''
}

// ── Values ──────────────────────────────────────────────────────────────────────
const current = (e) => {
  const v = getPath(tuningOverrides(e.group), e.path)
  return v === undefined ? e.def : v
}
const isChanged = (e) => changedSet.value.has(e.key)
const shown = (v) => (v === null ? t('flags.auto') : typeof v === 'string' ? v : JSON.stringify(v))
const fieldText = (v) => (v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

// What is typed but not applied yet, and why a typed value was refused: key → text / reason.
const drafts = reactive({})
const errors = reactive({})
watch(changedFlags, () => {
  // A change from elsewhere (the console, Reset all) shows the applied value again.
  for (const k of Object.keys(drafts)) if (!errors[k]) delete drafts[k]
})

function apply(e, value) {
  delete errors[e.key]
  delete drafts[e.key]
  const same = JSON.stringify(value) === JSON.stringify(e.def)
  if (same) {
    if (isChanged(e)) editFlag(e.group, e.path, undefined)
    return
  }
  if (JSON.stringify(value) !== JSON.stringify(current(e))) editFlag(e.group, e.path, value)
}

function invalidText(e, reason) {
  if (e.type === 'number') return e.def === null ? t('flags.invalid.numberOrEmpty') : t('flags.invalid.number')
  if (e.type === 'text') return t('flags.invalid.text')
  if (e.type === 'list' && /JSON/.test(reason)) return t('flags.invalid.list', { example: JSON.stringify(e.def) })
  return t('flags.invalid.refused', { reason })
}

// A typed value (number, text, list): applied when it parses as `set` would parse it,
// refused with the reason otherwise; nothing is applied until it is valid.
function commitText(e) {
  const text = drafts[e.key]
  if (text === undefined) return
  const raw = e.type === 'number' && e.def === null && text.trim() === '' ? 'null' : text
  const parsed = parseTuningValue(raw, e.def, e.choices)
  if (parsed.error) {
    errors[e.key] = invalidText(e, parsed.error)
    return
  }
  apply(e, parsed.value)
}

function commitTyped(e, value) {
  const checked = checkTuningValue(value, e.def, e.choices)
  if (checked.error) {
    errors[e.key] = invalidText(e, checked.error)
    return
  }
  apply(e, checked.value)
}

const onChoice = (e, index) => commitTyped(e, e.choices[Number(index)])
const choiceIndex = (e) => e.choices.findIndex((c) => c === current(e))

function cancelDraft(e) {
  delete drafts[e.key]
  delete errors[e.key]
}

// Esc in a field with a typed, unapplied value drops it; with none, it closes the dialog.
function escDraft(ev, e) {
  if (drafts[e.key] === undefined && !errors[e.key]) return
  ev.stopPropagation()
  ev.preventDefault()
  cancelDraft(e)
}

function resetRow(e) {
  cancelDraft(e)
  editFlag(e.group, e.path, undefined)
}

function confirmResetAll() {
  askConfirm({
    title: t('flags.confirm.title'),
    message: t('flags.confirm.message', { n: flagCount.value }),
    confirmLabel: t('flags.resetAll'),
    onConfirm: () => {
      for (const k of Object.keys(drafts)) delete drafts[k]
      for (const k of Object.keys(errors)) delete errors[k]
      resetAllFlags()
    },
  })
}

// ── Help ────────────────────────────────────────────────────────────────────────
const active = computed(() => (activeKey.value ? BY_KEY.get(activeKey.value) : null))
const activeHelp = computed(() => helpParagraphs(active.value?.help))
const groupLabel = (group) => t(`flags.tree.group.${group}`)
</script>

<template>
  <ModalShell
    :title="t('flags.title')"
    :subtitle="t('flags.changed', { n: flagCount })"
    :aria-label="t('flags.ariaLabel')"
    width="min(96vw, 1180px)"
    height="min(88vh, 820px)"
    flush
    :scroll="false"
    @close="emit('close')"
  >
    <template #actions>
      <input
        v-model="query"
        class="field-input fl-search"
        type="search"
        :placeholder="t('flags.search.placeholder')"
        :aria-label="t('flags.search.label')"
      />
    </template>

    <div class="fl-body">
      <p class="fl-intro">{{ t('flags.intro') }}</p>

      <div class="fl-split">
        <nav class="fl-tree" :aria-label="t('flags.tree.label')">
          <template v-for="node in TREE" :key="node.group">
            <button
              type="button"
              class="fl-node fl-group"
              :class="{ active: !searching && selected.group === node.group && selected.section == null }"
              @click="selectNode(node.group)"
            >
              <span class="fl-node-name"
                ><code>{{ node.group }}</code> <span class="fl-node-dim">{{ groupLabel(node.group) }}</span></span
              >
              <span
                v-if="changedIn(node.group)"
                class="fl-count"
                :title="t('flags.tree.changedTip', { n: changedIn(node.group) })"
                >{{ changedIn(node.group) }}</span
              >
            </button>
            <button
              v-for="s in node.sections"
              :key="`${node.group}/${s}`"
              type="button"
              class="fl-node fl-section"
              :class="{ active: !searching && selected.group === node.group && selected.section === s }"
              :title="s"
              @click="selectNode(node.group, s)"
            >
              <span class="fl-node-name">{{ s }}</span>
              <span
                v-if="changedIn(node.group, s)"
                class="fl-count"
                :title="t('flags.tree.changedTip', { n: changedIn(node.group, s) })"
                >{{ changedIn(node.group, s) }}</span
              >
            </button>
          </template>
        </nav>

        <div class="fl-main">
          <div v-if="searching" class="fl-results">{{ t('flags.results', { n: rows.length }) }}</div>
          <div class="fl-table-wrap">
            <table class="dt fl-table">
              <thead>
                <tr>
                  <th>{{ t('flags.col.name') }}</th>
                  <th>{{ t('flags.col.value') }}</th>
                  <th>{{ t('flags.col.default') }}</th>
                  <th>{{ t('flags.col.type') }}</th>
                  <th class="fl-reset-col" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="e in rows"
                  :key="e.key"
                  class="dt-row fl-row"
                  :class="{ changed: isChanged(e), selected: activeKey === e.key }"
                  @click="activeKey = e.key"
                  @focusin="activeKey = e.key"
                >
                  <td class="fl-name">
                    <code>{{ e.key }}</code>
                  </td>
                  <td class="fl-value">
                    <label v-if="e.type === 'boolean'" class="fl-switch">
                      <input
                        type="checkbox"
                        :checked="current(e)"
                        :aria-label="e.key"
                        @change="commitTyped(e, $event.target.checked)"
                      />
                      <span class="fl-slider" />
                    </label>
                    <select
                      v-else-if="e.type === 'choice'"
                      class="field-select"
                      :value="choiceIndex(e)"
                      :aria-label="e.key"
                      @change="onChoice(e, $event.target.value)"
                    >
                      <option v-for="(c, i) in e.choices" :key="i" :value="i">{{ shown(c) }}</option>
                    </select>
                    <template v-else>
                      <input
                        class="field-input fl-input"
                        :class="{ wide: e.type !== 'number' }"
                        type="text"
                        spellcheck="false"
                        :inputmode="e.type === 'number' ? 'decimal' : null"
                        :value="drafts[e.key] ?? fieldText(current(e))"
                        :placeholder="e.type === 'number' && e.def === null ? t('flags.autoHint') : null"
                        :aria-label="e.key"
                        :aria-invalid="errors[e.key] ? 'true' : null"
                        :title="errors[e.key] || null"
                        @input="drafts[e.key] = $event.target.value"
                        @change="commitText(e)"
                        @keydown.enter.prevent="commitText(e)"
                        @keydown.esc="(ev) => escDraft(ev, e)"
                      />
                      <div v-if="errors[e.key]" class="fl-error" role="alert">{{ errors[e.key] }}</div>
                    </template>
                  </td>
                  <td class="fl-default">
                    <code>{{ shown(e.def) }}</code>
                  </td>
                  <td class="fl-type">{{ t(`flags.type.${e.type}`) }}</td>
                  <td class="fl-reset-col">
                    <button
                      v-if="isChanged(e)"
                      type="button"
                      class="link-btn"
                      :title="t('flags.resetTip', { value: shown(e.def) })"
                      @click.stop="resetRow(e)"
                    >
                      {{ t('flags.reset') }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <section class="fl-help" aria-live="polite">
            <template v-if="active">
              <div class="fl-help-head">
                <code>{{ active.key }}</code>
                <span class="fl-node-dim">{{ t('flags.help.title') }}</span>
              </div>
              <p v-if="active.sharedWith" class="fl-help-shared">
                {{ t('flags.help.shared', { key: active.sharedWith }) }}
              </p>
              <p v-for="(p, i) in activeHelp" :key="i" class="fl-help-text">{{ p }}</p>
              <p v-if="!activeHelp.length" class="fl-help-empty">{{ t('flags.help.missing') }}</p>
            </template>
            <p v-else class="fl-help-empty">{{ t('flags.help.none') }}</p>
          </section>
        </div>
      </div>
    </div>

    <template #footer>
      <label class="checkbox-row fl-keep" :title="t('flags.keepTip')">
        <input type="checkbox" class="checkbox" :checked="keepFlags" @change="setKeepFlags($event.target.checked)" />
        <span>{{ t('flags.keep') }}</span>
      </label>
      <button
        type="button"
        class="btn"
        :disabled="!flagCount"
        :title="flagCount ? t('flags.resetAllTip') : t('flags.resetAllNone')"
        @click="confirmResetAll"
      >
        {{ t('flags.resetAll') }}
      </button>
      <button type="button" class="btn" @click="emit('close')">{{ t('common.close') }}</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.fl-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.fl-intro {
  margin: 0;
  padding: 10px 16px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-dim);
  border-bottom: 1px solid var(--panel-border);
}
.fl-search {
  width: 220px;
  max-width: 40vw;
}
.fl-split {
  flex: 1;
  min-height: 0;
  display: flex;
}
.fl-tree {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--panel-border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
}
.fl-node {
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  padding: 5px 8px;
  cursor: pointer;
}
.fl-node-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fl-group {
  color: var(--text);
  font-weight: 600;
  margin-top: 6px;
}
.fl-group:first-child {
  margin-top: 0;
}
.fl-section {
  padding-left: 22px;
}
.fl-node:hover:not(.active) {
  background: var(--hover-bg);
  color: var(--text);
}
.fl-node.active {
  background: var(--accent);
  color: #fff;
}
.fl-node.active .fl-node-dim {
  color: inherit;
}
.fl-node-dim {
  color: var(--text-dim);
  font-weight: 400;
}
.fl-count {
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: rgb(230, 160, 30);
  color: #1b1b1b;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
.fl-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.fl-results {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--panel-border);
}
.fl-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.fl-table {
  font-size: 12.5px;
}
.fl-table tbody td {
  padding: 4px 10px;
  vertical-align: middle;
}
.fl-row {
  cursor: pointer;
}
.fl-row.selected {
  background: var(--hover-bg);
}
.fl-row.changed .fl-name code,
.fl-row.changed .fl-value,
.fl-row.changed .fl-value :is(input, select) {
  font-weight: 700;
}
.fl-row.changed .fl-name code {
  color: var(--text);
}
.fl-name code,
.fl-default code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.fl-name code {
  color: var(--text);
}
.fl-default,
.fl-type {
  color: var(--text-dim);
}
.fl-input {
  width: 120px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.fl-input.wide {
  width: 200px;
}
.fl-error {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--danger, #e05252);
  white-space: normal;
  max-width: 260px;
}
.fl-reset-col {
  width: 1%;
  text-align: right;
}
.fl-switch {
  position: relative;
  display: inline-block;
  width: 32px;
  height: 18px;
  vertical-align: middle;
}
.fl-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.fl-slider {
  position: absolute;
  inset: 0;
  background: var(--panel-border);
  border-radius: 18px;
  cursor: pointer;
  transition: background 0.15s;
}
.fl-slider::before {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s;
}
.fl-switch input:checked + .fl-slider {
  background: var(--accent);
}
.fl-switch input:checked + .fl-slider::before {
  transform: translateX(14px);
}
.fl-switch input:focus-visible + .fl-slider {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.fl-help {
  flex-shrink: 0;
  max-height: 34%;
  overflow-y: auto;
  border-top: 1px solid var(--panel-border);
  padding: 10px 14px;
  font-size: 12.5px;
  line-height: 1.55;
  background: var(--bg);
}
.fl-help-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
  margin-bottom: 4px;
}
.fl-help-head code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}
.fl-help-text,
.fl-help-shared,
.fl-help-empty {
  margin: 4px 0 0;
}
.fl-help-shared,
.fl-help-empty {
  color: var(--text-dim);
}
.fl-keep {
  margin-right: auto;
  font-size: 12.5px;
}
@media (max-width: 760px) {
  .fl-split {
    flex-direction: column;
  }
  .fl-tree {
    width: auto;
    max-height: 120px;
    border-right: none;
    border-bottom: 1px solid var(--panel-border);
  }
  .fl-search {
    width: 140px;
  }
  .fl-help {
    max-height: 30%;
  }
}
</style>
