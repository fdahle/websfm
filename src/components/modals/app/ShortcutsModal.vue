<script setup>
// Help ▸ Shortcuts (or ?): every keyboard shortcut and modifier gesture, grouped by
// where it works. The rows come from core/help/shortcuts.js, the same table the key
// handlers match against, so the list is what the keys do. Keycaps are spelled for
// this platform (⌘ on a Mac).
import { computed, nextTick, onMounted, ref } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import { shortcutSections } from '../../../core/help/shortcuts.js'
import { IS_MAC } from '../../../utils/shortcutLabels.js'

const emit = defineEmits(['close'])

const query = ref('')
const search = ref(null)
const sections = computed(() => shortcutSections(query.value, IS_MAC))
onMounted(() => nextTick(() => search.value?.focus()))
</script>

<template>
  <ModalShell title="Keyboard shortcuts" width="760px" @close="emit('close')">
    <div class="sc-top">
      <input
        ref="search"
        v-model="query"
        class="field-input sc-search"
        type="search"
        placeholder="Filter by action or key…"
        aria-label="Filter shortcuts"
      />
      <span class="sc-note">{{ IS_MAC ? '⌘ is Command, ⌥ Option, ⇧ Shift.' : 'On a Mac, Ctrl is ⌘.' }}</span>
    </div>

    <div v-if="sections.length" class="sc-groups">
      <section v-for="g in sections" :key="g.id" class="sc-group">
        <h3 class="sc-head">{{ g.title }}</h3>
        <div class="sc-list">
          <div v-for="s in g.shortcuts" :key="s.id" class="sc-row">
            <span class="sc-keys">
              <template v-for="(c, i) in s.combos" :key="i">
                <span v-if="i" class="sc-or">or</span>
                <span class="sc-combo">
                  <kbd v-for="(k, j) in c.keys" :key="j" :class="{ mouse: c.mouse && j === c.keys.length - 1 }">{{
                    k
                  }}</kbd>
                </span>
              </template>
            </span>
            <span class="sc-does">{{ s.does }}</span>
          </div>
        </div>
      </section>
    </div>
    <p v-else class="sc-empty">No shortcut matches “{{ query }}”.</p>

    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.sc-top {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.sc-search {
  flex: 1 1 220px;
  max-width: 320px;
}
.sc-note {
  font-size: 11.5px;
  color: var(--text-dim);
}
.sc-groups {
  columns: 2 300px;
  column-gap: 28px;
}
.sc-group {
  break-inside: avoid;
  margin: 0 0 16px;
}
.sc-head {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin: 0 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--panel-border);
}
/* One grid per group, so its descriptions start in one column. */
.sc-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  align-items: baseline;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--text);
}
.sc-row {
  display: contents;
}
.sc-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
}
.sc-combo {
  display: inline-flex;
  gap: 2px;
  white-space: nowrap;
}
.sc-or {
  font-size: 11px;
  color: var(--text-dim);
}
kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1;
  min-width: 1.6em;
  text-align: center;
  padding: 3px 5px;
  border: 1px solid var(--panel-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
/* Click / Drag is a mouse action, not a key: no keycap. */
kbd.mouse {
  font-family: inherit;
  border-color: transparent;
  background: none;
  color: var(--text-dim);
  padding-left: 2px;
}
.sc-does {
  color: var(--text);
}
.sc-empty {
  font-size: 12.5px;
  color: var(--text-dim);
}
</style>
