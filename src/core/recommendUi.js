// Pure U3 helpers. A recommendation is shown only when it differs from the
// stage's static default; applying it remains an explicit UI action. Keeping the
// comparison here pins that policy without importing Vue into core.
//
// Presentation-wise a recommendation is NOT its own banner: where the derived
// knobs are the same knobs a quality preset tunes (detection), it becomes one
// more **preset card**, so a modal keeps exactly one hero control. Where a stage
// already has a card per recommended value (depth-map quality), the existing card
// is badged instead of adding a redundant one — `badgePreset` below. Everything
// here is card *metadata* (`{ id, label, blurb, badge, title }`, the shape
// `PresetCards` renders); no Vue, no application.

export const RECOMMENDED_PRESET_ID = 'recommended'

const humanize = (key) => key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())

export function diffRecommendations(recommendations = {}, baseline = {}) {
  const out = []
  for (const [key, rec] of Object.entries(recommendations || {})) {
    if (!rec || !Object.hasOwn(rec, 'value')) continue
    if (!Object.is(rec.value, baseline?.[key])) {
      out.push({ key, value: rec.value, reason: String(rec.reason || '') })
    }
  }
  return out
}

export function recommendationPatch(items = []) {
  return Object.fromEntries(items.map(({ key, value }) => [key, value]))
}

export function recommendationLabel(key, labels = {}) {
  return labels?.[key] || humanize(key)
}

export function formatRecommendationValue(value) {
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  return String(value)
}

/** One auditable "knob = value — why" line per recommendation (log + tooltip). */
export function recommendationLines(items = [], labels = {}) {
  return items.map(
    (item) =>
      `${recommendationLabel(item.key, labels)} = ${formatRecommendationValue(item.value)}`
      + (item.reason ? ` — ${item.reason}` : ''),
  )
}

/**
 * The dataset-derived preset card, or null when nothing was derived. Unlike the
 * static `*_PRESET_META` deltas this one's values depend on the data — which is
 * the whole point, and why it carries its reasons in `title` rather than a blurb
 * a reader would have to trust.
 */
export function recommendedPresetCard(items = [], { labels = {}, label = 'Recommended' } = {}) {
  if (!items.length) return null
  const names = items.map((item) => recommendationLabel(item.key, labels).toLowerCase())
  return {
    id: RECOMMENDED_PRESET_ID,
    label,
    blurb: `Tuned to this dataset · ${names.join(' · ')}`,
    badge: '★',
    title: recommendationLines(items, labels).join('\n'),
  }
}

/**
 * Mark one existing card as the recommended choice. For a stage whose cards ARE
 * the recommended values (depth-map quality), adding a second "Recommended" card
 * would offer the same setting twice.
 */
export function badgePreset(presets = [], id, { badge = 'Recommended', title = '' } = {}) {
  if (id == null) return presets
  return presets.map((p) => (p.id === id ? { ...p, badge, title } : p))
}
