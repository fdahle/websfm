// A long run's journal: what it was started with and how far it got, saved while it
// runs (utils/opfs/runs.js, `runs/<stage>.json`) and deleted when it finishes. A
// project opened with a journal still in it was left by a tab that died (closed,
// crashed, killed by the browser for memory): its work so far is on disk, and the
// journal says how to continue it.
//
// journal = { stage, key, settings, startedAt, updatedAt, total, phase, done, … }
//   key       digest of the inputs the saved work depends on (journalKey); a project
//             whose inputs changed since cannot continue the run
//   settings  as the dialog started it, so Continue runs exactly the same settings
//   phase     where the run is (a stage's own names, e.g. 'pass1', 'filter')
//   done      the units already saved in the current phase (stage-specific records)

/** A stable string for plain data: object keys sorted, so key order never matters. */
export function stableStringify(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 64-bit FNV-1a of `parts` (plain data) as 16 hex digits. Not cryptographic. */
export function journalKey(parts) {
  const text = stableStringify(parts)
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i))
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

/**
 * A new journal for a run.
 * @param {{ stage: string, key: string, settings: object, total: number, phase: string, now?: Date }} args
 */
export function startJournal({ stage, key, settings, total, phase, now = new Date() }) {
  const at = now.toISOString()
  return {
    stage,
    key,
    settings: structuredClone(settings ?? {}),
    startedAt: at,
    updatedAt: at,
    total,
    phase,
    firstPhase: phase,
    done: [],
  }
}

/**
 * Whether a saved journal can be continued on the project as it is now.
 * @param {object|null} journal
 * @param {string} key the current inputs' journalKey
 * @returns {{ ok: boolean, why?: string }}
 */
export function canContinue(journal, key) {
  if (!journal || typeof journal !== 'object') return { ok: false, why: 'no interrupted run' }
  if (journal.key !== key) return { ok: false, why: 'its inputs changed since it stopped' }
  return { ok: true }
}

/**
 * What the Continue prompt says: "Depth maps stopped at 212 of 347, 2 h 10 min ago."
 * @param {object} journal
 * @param {string} label the stage's name in the UI
 * @param {Date} [now]
 */
// Past its first phase a run has saved every unit once; `done` then counts a later
// phase's units (depth maps' second pass), or none (the filter, matching's passes), and
// an empty count must not read as "stopped at 0".
const FIRST_PHASES = new Set(['images', 'pairs', 'pass1'])
export function journalSummary(journal, label, now = new Date()) {
  const ago = agoText(now - new Date(journal.updatedAt ?? journal.startedAt))
  const total = journal.total > 0 ? journal.total.toLocaleString('en-US') : null
  const first = journal.firstPhase
    ? journal.phase === journal.firstPhase
    : !journal.phase || FIRST_PHASES.has(journal.phase)
  const n = journal.done?.length ?? 0
  const where = !total
    ? ''
    : first
      ? ` at ${n.toLocaleString('en-US')} of ${total}`
      : n
        ? ` at ${n.toLocaleString('en-US')} of ${total} in a later step`
        : ` after all ${total} were saved, in a later step`
  return `${label} stopped${where}${ago ? `, ${ago} ago` : ''}.`
}

function agoText(ms) {
  if (!(ms > 0)) return ''
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'less than a minute'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  return `${Math.round(h / 24)} days`
}

/**
 * Saves a journal at most once per `intervalMs` while units finish, and at once when
 * asked (`flush`): a run of thousands of short units must not rewrite it thousands of
 * times. `write(journal)` returns a promise; writes never overlap.
 */
export function journalWriter(write, { intervalMs = 15_000, now = () => Date.now() } = {}) {
  let last = 0
  let pending = null
  let inFlight = Promise.resolve()
  const run = (journal) => {
    pending = null
    last = now()
    const snapshot = { ...journal, updatedAt: new Date(last).toISOString(), done: [...journal.done] }
    inFlight = inFlight.then(() => write(snapshot)).catch(() => {})
    return inFlight
  }
  return {
    // A unit finished: save if the interval has passed, else remember to.
    touch(journal) {
      if (now() - last >= intervalMs) return run(journal)
      pending = journal
      return inFlight
    },
    // Save now (a phase change, the end of a stage).
    flush(journal = pending) {
      return journal ? run(journal) : inFlight
    },
    settled: () => inFlight,
  }
}
