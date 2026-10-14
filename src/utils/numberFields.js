// Validation for the numeric settings fields of the run dialogs (Dense, Depth Maps,
// Mesh, DEM, …).
//
// `v-model.number` on an <input type="number"> yields '' when the field is cleared
// (and the raw string for text it cannot parse), and the browser's own min/max/step
// checks only colour the field — nothing stops that value reaching an engine. Each
// dialog states its fields' rules (taken from the inputs' own min / max / step
// attributes) and disables Run while any is out of range, with the reason as the
// button's title and the offending inputs marked aria-invalid.
//
// Rules are per field key, and `values` is a plain object of the current values —
// usually the dialog's `settings`, or one assembled from several refs:
//   label     what the reason calls the field (its visible label)
//   min, max  inclusive bounds, as the input's min/max attributes
//   integer   whole numbers only (the input steps by an integer)
//   optional  blank ('' / null) is a valid "auto" — the field's placeholder says so
//   when      false ⇒ the field is hidden / unused for this run; not checked

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 6 })

/** Why `value` breaks `rule`, or '' when it is fine. */
export function numberFieldError(value, rule = {}) {
  const { min, max, integer = false, optional = false } = rule
  if (value === '' || value == null) return optional ? '' : 'enter a value'
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'enter a number'
  if (integer && !Number.isInteger(value)) return 'must be a whole number'
  const below = min != null && value < min
  const above = max != null && value > max
  if (!below && !above) return ''
  if (min != null && max != null) return `must be between ${fmt(min)} and ${fmt(max)}`
  return below ? `must be at least ${fmt(min)}` : `must be at most ${fmt(max)}`
}

/**
 * Check every applicable field.
 * @param {Record<string, unknown>} values
 * @param {Record<string, {label?: string, min?: number, max?: number, integer?: boolean,
 *   optional?: boolean, when?: boolean}>} rules
 * @returns {{ valid: boolean, invalid: {key: string, label: string, message: string}[],
 *   bad: Record<string, boolean>, reason: string }}
 *   `bad[key]` is true for an invalid field, false for a checked valid one (bind it to
 *   aria-invalid); `reason` is one line naming every invalid field ('' when valid).
 */
export function checkNumberFields(values, rules) {
  const invalid = []
  const bad = {}
  for (const [key, rule] of Object.entries(rules)) {
    if (rule.when === false) continue
    const message = numberFieldError(values?.[key], rule)
    bad[key] = !!message
    if (message) invalid.push({ key, label: rule.label ?? key, message })
  }
  return {
    valid: invalid.length === 0,
    invalid,
    bad,
    reason: invalid.map((f) => `${f.label}: ${f.message}`).join('; '),
  }
}
