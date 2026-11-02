// Saved dialog settings (last used per project, named presets per browser) brought back
// into a dialog safely: only the keys the dialog still has, each only when its value is
// of the same kind as the default's. A setting renamed or removed since, or a value of
// another type, falls back to the default, so an old preset can never hand a dialog
// something it no longer understands. Pure.

const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)

// `saved` over `defaults`: { settings, dropped (keys left out) }.
export function normalizeSettings(saved, defaults) {
  const settings = { ...defaults }
  const dropped = []
  for (const [k, v] of Object.entries(saved ?? {})) {
    if (!(k in defaults)) {
      dropped.push(k)
      continue
    }
    const d = defaults[k]
    // A null default is an "auto" a number or string may replace; otherwise the kinds match.
    const ok = d === null ? v === null || ['number', 'string'].includes(typeof v) : kind(v) === kind(d)
    if (ok && (typeof v !== 'number' || Number.isFinite(v))) settings[k] = Array.isArray(v) ? [...v] : v
    else dropped.push(k)
  }
  return { settings, dropped }
}

// The keys of `settings` that differ from `defaults` (what a preset needs to keep).
export function changedSettings(settings, defaults) {
  const out = {}
  for (const [k, v] of Object.entries(settings ?? {})) {
    if (!(k in (defaults ?? {}))) continue
    const d = defaults[k]
    const same = Array.isArray(v) ? Array.isArray(d) && v.length === d.length && v.every((x, i) => x === d[i]) : v === d
    if (!same) out[k] = Array.isArray(v) ? [...v] : v
  }
  return out
}

// A preset name as it is kept: trimmed, at most 60 characters, never empty.
export function presetName(name) {
  const n = String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 60)
  return n || null
}
