import { computed } from 'vue'
import { profileDataset } from '../core/profile.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { usePosesStore } from '../stores/usePosesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useComputeSettings } from './useComputeSettings.js'

// One reactive U1→U2→C1 bridge shared by every pipeline modal. The profiler
// reads metadata/store state only; no pixels or hidden processing are involved.
export function useDatasetRecommendations() {
  const images = useImagesStore()
  const sensors = useSensorsStore()
  const poses = usePosesStore()
  const gcps = useGcpsStore()
  const { recommendForDataset } = useComputeSettings()

  const profile = computed(() => profileDataset({
    images: images.images,
    sensors: sensors.sensors,
    poses: poses.poses,
    gcps: gcps.gcps,
  }))
  const recommendations = computed(() => recommendForDataset(profile.value))

  return { profile, recommendations }
}
