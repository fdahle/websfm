import { computed, ref, unref } from 'vue'

// Quality-preset state for a pipeline dialog's <PresetCards> hero (Reconstruct, Match,
// Mesh, Filter Cloud, Detect Features).
//
// A preset in core/defaults.user.js is a DELTA over the dialog's defaults
// (`medium: {}` ≡ the defaults). The keys a dialog's presets patch are the keys the
// presets OWN; every other setting (a pairing strategy's window, a mesh's cleanup
// toggles, a resolution mode…) is orthogonal to them. So:
//   - `selectPreset(id)` writes only the owned keys — `{ ...defaults, ...preset }`
//     restricted to them — and leaves the user's other settings alone;
//   - `activePreset` compares only the owned keys, so changing an orthogonal setting
//     does not turn the card into "· modified".
// Owned keys default to the union of every preset's keys (including a preset that
// only some cards carry, e.g. a dataset-recommended card), so a key one card sets is
// reset by the others. Pass `ownedKeys` to state them explicitly instead.
//
// Every option may be a plain value, a ref/computed, or a getter:
//   settings   writable ref (or writable computed) holding the settings object
//   defaults   the object the presets patch
//   presets    { [id]: patch }
//   cards      the card order `activePreset` checks ([{ id }] or [id]); the first
//              match wins. Defaults to the presets' own order.
//   initialId  the card the dialog opens on (`baseId`'s start value)
const read = (v) => (typeof v === 'function' ? v() : unref(v))

/** Equality for a setting value: arrays (e.g. a filter's `methods`) compare by element. */
export function sameSettingValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
  }
  return a === b
}

const clone = (v) => (Array.isArray(v) ? [...v] : v)

/** The union of keys the given preset patches set, in first-seen order. */
export function presetOwnedKeys(presets) {
  const keys = new Set()
  for (const patch of Object.values(presets ?? {})) for (const k of Object.keys(patch ?? {})) keys.add(k)
  return [...keys]
}

export function usePresetSettings({ settings, defaults, presets, cards, initialId = 'medium', ownedKeys }) {
  const baseId = ref(initialId)
  const owned = computed(() => read(ownedKeys) ?? presetOwnedKeys(read(presets)))
  const cardIds = computed(() =>
    (read(cards) ?? Object.keys(read(presets) ?? {})).map((c) => (typeof c === 'string' ? c : c.id)),
  )

  /** The owned-key values preset `id` stands for: defaults patched by the preset. */
  function resolvePreset(id) {
    const base = read(defaults) ?? {}
    const patch = read(presets)?.[id] ?? {}
    const out = {}
    for (const k of owned.value) out[k] = k in patch ? patch[k] : base[k]
    return out
  }

  const activePreset = computed(() => {
    const s = settings.value ?? {}
    for (const id of cardIds.value) {
      const r = resolvePreset(id)
      if (owned.value.every((k) => sameSettingValue(s[k], r[k]))) return id
    }
    return 'custom'
  })

  function selectPreset(id) {
    const r = resolvePreset(id)
    const patch = {}
    for (const k of Object.keys(r)) patch[k] = clone(r[k])
    settings.value = { ...settings.value, ...patch }
    baseId.value = id
  }

  return { baseId, activePreset, ownedKeys: owned, resolvePreset, selectPreset }
}
