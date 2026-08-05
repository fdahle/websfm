import { computed, unref } from 'vue'
import {
  RECOMMENDED_PRESET_ID,
  diffRecommendations,
  recommendationLines,
  recommendationPatch,
  recommendedPresetCard,
} from '../core/recommendUi.js'
import { useLog } from './useLog.js'

// U3 presentation glue: turn one stage's `{ knob: { value, reason } }` map into a
// preset card the modal can offer alongside its static quality presets.
//
// Eligibility is deliberately against the STATIC defaults, not the live modal
// values — a card whose contents depended on what the user had already typed
// would change meaning under them. Selecting it is the only thing that writes
// settings; nothing here mutates on open.
//
// `stage`/`labels` exist for the audit line: applying a derived value logs the
// value AND the reason, so a run stays reproducible from the log alone.
export function useRecommendedPreset({ stage, recommendations, defaults, labels = {} }) {
  const { log } = useLog()

  const items = computed(() => diffRecommendations(unref(recommendations), unref(defaults)))
  const patch = computed(() => recommendationPatch(items.value))
  const card = computed(() => recommendedPresetCard(items.value, { labels: unref(labels) }))
  const hasRecommendation = computed(() => items.value.length > 0)

  /** The stage's cards with the recommended one first, or unchanged when there is none. */
  const withRecommended = (presets) => (card.value ? [card.value, ...unref(presets)] : unref(presets))

  function logApplied() {
    for (const line of recommendationLines(items.value, unref(labels))) {
      log(`Recommended ${stage}: ${line}`, 'info', 'Recommend')
    }
  }

  return { RECOMMENDED_PRESET_ID, items, patch, card, hasRecommendation, withRecommended, logApplied }
}
