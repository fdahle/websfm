<script setup>
// App identity + acknowledgments (courtesy credit for prior art) + third-party
// license notices (a legal obligation for the code/weights we ship). Hardware /
// storage diagnostics live in SystemInfoModal (its own ribbon entry) — this modal
// is about the app, not the machine. Both attribution lists come from
// core/help/licenses.js, the single maintained source of truth.
import { ref } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import Icon from '../../Icon.vue'
import BetaBadge from '../../layout/BetaBadge.vue'
import { ACKNOWLEDGMENTS, THIRD_PARTY } from '../../../core/help/licenses.js'
import { REFERENCES, formatReference, referenceUrl } from '../../../core/help/references.js'
import { version as appVersion } from '../../../../package.json'

const emit = defineEmits(['close'])
const licenseUrl = `${import.meta.env.BASE_URL}LICENSE`

// Every published method WebSfM implements (core/help/references.js), by first author.
const references = Object.keys(REFERENCES)
  .map((key) => ({ key, text: formatReference(key, { link: false }), url: referenceUrl(key) }))
  .sort((a, b) => a.text.localeCompare(b.text))

const tab = ref('about')
const tabs = [
  { id: 'about', label: 'About' },
  { id: 'credits', label: 'Acknowledgments' },
  { id: 'references', label: 'References' },
  { id: 'licenses', label: 'Licenses' },
]
</script>

<template>
  <ModalShell title="About" aria-label="About" @close="emit('close')">
    <!-- Brand hero -->
    <div class="hero">
      <div class="hero-mark"><Icon name="cube" /></div>
      <div class="hero-text">
        <div class="hero-name">WebSfM <BetaBadge /></div>
        <div class="hero-tag">Browser-based Structure&nbsp;from&nbsp;Motion · v{{ appVersion }}</div>
      </div>
    </div>

    <div class="tabs">
      <button v-for="t in tabs" :key="t.id" class="tab" :class="{ active: tab === t.id }" @click="tab = t.id">
        {{ t.label }}
      </button>
    </div>

    <!-- Identity -->
    <div v-show="tab === 'about'" class="pane">
      <p class="lede">
        A complete photogrammetry pipeline — detection, matching, sparse &amp; dense reconstruction, meshing and
        orthophotos — that runs entirely in your browser. No server, no upload: your images never leave your machine.
      </p>
      <div class="chips">
        <a class="chip" href="https://github.com/fdahle/websfm" target="_blank" rel="noopener">
          <Icon name="link" /> GitHub
        </a>
        <!-- Also the bottom-right bug button's target, which Settings can hide. -->
        <a class="chip" href="https://github.com/fdahle/websfm/issues/new" target="_blank" rel="noopener">
          <Icon name="bug" /> Report a bug
        </a>
        <a class="chip" :href="licenseUrl" target="_blank" rel="noopener"> <Icon name="file" /> MIT License </a>
      </div>
    </div>

    <!-- Acknowledgments (courtesy) -->
    <div v-show="tab === 'credits'" class="pane">
      <p class="lede">WebSfM stands on decades of open research and software. Its methods draw on:</p>
      <ul class="ack-list">
        <li v-for="a in ACKNOWLEDGMENTS" :key="a.name" class="ack-item">
          <a :href="a.url" target="_blank" rel="noopener" class="ack-name">{{ a.name }}</a>
          <span class="ack-note">{{ a.note }}</span>
        </li>
      </ul>
    </div>

    <!-- References (the papers behind the methods) -->
    <div v-show="tab === 'references'" class="pane">
      <p class="lede">
        The published methods WebSfM implements. Each glossary entry lists the ones it describes under
        <em>Sources</em>; the Quality Report lists those a project's run used.
      </p>
      <ol class="ref-list">
        <li v-for="r in references" :key="r.key">
          {{ r.text }}
          <a v-if="r.url" :href="r.url" target="_blank" rel="noopener">{{ r.url.replace(/^https:\/\//, '') }}</a>
        </li>
      </ol>
    </div>

    <!-- Third-party licenses (obligation) -->
    <div v-show="tab === 'licenses'" class="pane">
      <p class="lede">Bundled third-party software, models and example data, with their licenses:</p>
      <div v-for="g in THIRD_PARTY" :key="g.group" class="lic-group">
        <div class="group-head">{{ g.group }}</div>
        <div v-for="it in g.items" :key="it.name" class="lic-item">
          <div class="lic-row">
            <a :href="it.url" target="_blank" rel="noopener" class="lic-name">{{ it.name }}</a>
            <span v-if="it.version" class="lic-ver">{{ it.version }}</span>
            <span class="lic-badge">{{ it.license }}</span>
          </div>
          <div v-if="it.notice" class="lic-notice">{{ it.notice }}</div>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.ref-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--text-dim);
}
.ref-list li {
  margin-bottom: 6px;
  overflow-wrap: anywhere;
}
.ref-list a {
  color: var(--accent);
}
/* Brand hero */
.hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 16px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--panel-border);
}
.hero-mark {
  width: 46px;
  height: 46px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #7c5cff));
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 40%, transparent);
}
.hero-mark :deep(.icon) {
  width: 26px;
  height: 26px;
}
.hero-name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text);
  line-height: 1.1;
}
.hero-tag {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 3px;
}

/* Tabs */
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  margin: 16px 0 16px;
  background: var(--panel-border);
  border-radius: 8px;
}
.tab {
  flex: 1;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 500;
  padding: 6px 8px;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}
.tab:hover {
  color: var(--text);
}
.tab.active {
  color: var(--text);
  background: var(--panel);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}

.pane {
  min-height: 190px;
}
.lede {
  font-size: 12.5px;
  color: var(--text-dim);
  line-height: 1.55;
  margin: 0 0 16px;
}

/* About chips */
.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  font-size: 12px;
  color: var(--text);
  text-decoration: none;
  transition:
    border-color 0.12s,
    background 0.12s;
}
.chip:hover {
  border-color: var(--accent);
  background: var(--hover-bg);
}
.chip :deep(.icon) {
  width: 14px;
  height: 14px;
  color: var(--text-dim);
}

/* Acknowledgments */
.ack-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ack-item {
  padding: 11px 13px;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
}
.ack-name {
  display: block;
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
}
.ack-name:hover {
  text-decoration: underline;
}
.ack-note {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.5;
}

/* Licenses */
.lic-group + .lic-group {
  margin-top: 18px;
}
.group-head {
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-dim);
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--panel-border);
}
.lic-item {
  padding: 5px 0;
}
.lic-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.lic-name {
  color: var(--text);
  text-decoration: none;
  font-size: 12.5px;
  font-weight: 500;
}
.lic-name:hover {
  color: var(--accent);
  text-decoration: underline;
}
.lic-ver {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.lic-badge {
  margin-left: auto;
  font-size: 10.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text-dim);
  background: var(--panel-border);
  padding: 2px 7px;
  border-radius: 5px;
  white-space: nowrap;
}
.lic-notice {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.45;
  margin-top: 4px;
}
</style>
