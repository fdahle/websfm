<script setup>
import { version as appVersion } from '../../../package.json'
import { isBetaVersion } from '../../core/help/changelog.js'

// "Beta" beside the app name while the version is 0.x or a pre-release: features and
// the project format still change between versions. Gone at 1.0 without an edit.
const beta = isBetaVersion(appVersion)
</script>

<template>
  <span
    v-if="beta"
    class="beta-badge"
    title="WebSfM is in beta: features and the project format still change between versions. Keep your source images."
    >Beta</span
  >
</template>

<style scoped>
.beta-badge {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.4;
  text-transform: uppercase;
  vertical-align: middle;
  cursor: default;
}
</style>
