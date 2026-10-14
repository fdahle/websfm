// Engine-boundary option sanitizers shared by every dense stage (depthMap.js,
// geomFilter.js, fusionPlan.js): numOpt / boolOpt and why they exist.

// ── User-facing options (engine boundary) ───────────────────────────────────
// The dialogs bind their numeric fields with v-model.number, which hands back '' for a
// cleared field (and NaN for some partial input). Destructuring defaults replace only
// `undefined`, so '' used to reach the loops: `v += ''` turns a row index into the
// string "0" and fusion never finished; a blank pyramid target built levels forever.
// Every user-facing number is read through `numOpt`: anything that is not a number in
// [min, max] (after an integer floor when `int`) falls back to the documented default.
// A non-blank numeric string is read as its number. The dialogs validate too; this is
// the backstop.
export function numOpt(v, def, { min = -Infinity, max = Infinity, int = false, positive = false } = {}) {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v)
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  if (int) v = Math.floor(v)
  if (v < min || v > max || (positive && !(v > 0))) return def
  return v
}
export const boolOpt = (v, def) => (typeof v === 'boolean' ? v : def)
