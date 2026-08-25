// Pure text helpers for user-facing strings (log lines, hints, report copy).
//
// Lives in core/ rather than utils/ for one reason: core modules must be able to
// call it. `core/**` imports nothing from `utils/**` by design, and most of the
// counted strings in this app are produced inside core (SfM, dense, io) — a
// helper in utils/ would have forced every core call site to keep its own copy,
// which is the duplication it exists to remove.

/**
 * A count and its noun, in agreement.
 *   pluralize(1, 'camera position') → "1 camera position"
 *   pluralize(2, 'camera position') → "2 camera positions"
 *   pluralize(3, 'entry', 'entries') → "3 entries"
 *
 * Log lines are read by users, and "1 position(s)" is the tell that nobody looked
 * at the output. Pass an explicit plural for irregular nouns.
 *
 * @param {number} n
 * @param {string} singular
 * @param {string} [pluralForm] defaults to `${singular}s`
 */
export function pluralize(n, singular, pluralForm = `${singular}s`) {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

/**
 * The noun alone, agreeing with a count that is rendered separately — for the
 * "7/12 pairs" shape, where the number is a ratio rather than the count itself.
 *   `${a}/${b} ${nounFor(b, 'pair')}`
 */
export function nounFor(n, singular, pluralForm = `${singular}s`) {
  return n === 1 ? singular : pluralForm
}
