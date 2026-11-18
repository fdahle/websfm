<script setup>
import { isBetaVersion } from '../../core/help/changelog.js'
import { useI18n } from '../../composables/useI18n.js'
import { APP_VERSION, PINNED } from '../../utils/appBuild.js'

// The badges beside the app name. "Beta" while the version is 0.x or a pre-release:
// features and the project format still change between versions; gone at 1.0 without
// an edit. "Pinned" in the pinned copy of a release (/v/<version>/, core/appVersion.js),
// so an old version is never taken for the newest.
const { t } = useI18n()
const beta = isBetaVersion(APP_VERSION)
</script>

<template>
  <span v-if="beta || PINNED" class="version-badges">
    <span v-if="beta" class="version-badge" :title="t('about.badge.betaTitle')">{{ t('about.badge.beta') }}</span>
    <span v-if="PINNED" class="version-badge pinned" :title="t('about.badge.pinnedTitle', { version: APP_VERSION })">{{
      t('about.badge.pinned')
    }}</span>
  </span>
</template>

<style scoped>
.version-badge {
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
.version-badges {
  display: inline-flex;
  gap: 4px;
  vertical-align: middle;
}
.version-badge.pinned {
  border-color: var(--warn, #d9a441);
  color: var(--warn, #d9a441);
}
</style>
