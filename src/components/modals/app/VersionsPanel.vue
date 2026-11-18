<script setup>
// About ▸ Version: which WebSfM this is (the newest, or a pinned copy of a release at
// /v/<version>/, docs/deployment.md ▸ Pinned versions), a link to keep using this
// version, and the other versions the site keeps. The list is /v/versions.json, served
// by the site's worker; where there is none (npm run dev, another host), only the
// first line shows.
import { onMounted, ref } from 'vue'
import { useI18n } from '../../../composables/useI18n.js'
import { otherVersions, pinnedUrl } from '../../../core/appVersion.js'
import { APP_VERSION, PINNED } from '../../../utils/appBuild.js'

const { t } = useI18n()
// null until the list loads, and when the site has none.
const others = ref(null)
const thisOneKept = ref(false)

onMounted(async () => {
  try {
    const res = await fetch('/v/versions.json', { cache: 'no-cache' })
    if (!res.ok) return
    const json = await res.json()
    others.value = otherVersions(json, APP_VERSION)
    thisOneKept.value = Array.isArray(json?.versions) && json.versions.includes(APP_VERSION)
  } catch {
    // No list here: nothing more to offer.
  }
})
</script>

<template>
  <section class="versions">
    <div class="versions-head">{{ t('about.versions.heading') }}</div>
    <p class="versions-line">
      {{
        PINNED
          ? t('about.versions.pinned', { version: APP_VERSION })
          : t('about.versions.newest', { version: APP_VERSION })
      }}
    </p>
    <p v-if="PINNED || thisOneKept || others?.length" class="versions-links">
      <a v-if="PINNED" href="/">{{ t('about.versions.openNewest') }}</a>
      <a
        v-else-if="thisOneKept"
        :href="pinnedUrl(APP_VERSION)"
        :title="t('about.versions.pinThisTitle', { version: APP_VERSION })"
        >{{ t('about.versions.pinThis', { version: APP_VERSION }) }}</a
      >
      <template v-if="others?.length">
        <span class="versions-others">{{ t('about.versions.others') }}</span>
        <a v-for="v in others" :key="v" :href="pinnedUrl(v)" class="versions-item">{{ v }}</a>
      </template>
    </p>
    <p v-if="PINNED || others?.length" class="versions-note">{{ t('about.versions.shared') }}</p>
  </section>
</template>

<style scoped>
.versions {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--panel-border);
  font-size: 12px;
}
.versions-head {
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}
.versions-line,
.versions-links,
.versions-note {
  margin: 0 0 6px;
  color: var(--text-dim);
}
.versions-links {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
.versions a {
  color: var(--accent);
}
.versions-others {
  margin-left: 4px;
}
.versions-note {
  font-size: 11px;
}
</style>
