import { formatClock, formatRemaining } from './timeFormat.js'
import { pluralize, nounFor } from '../core/textFormat.js'

// How often a long run's progress lines may appear in the log: after `everyMs`, then
// after twice as long each time up to `maxMs` (30 s, 1, 2, 4 min, then every 5 min), so a
// run shows early that it moves without filling the log: about six lines in twenty
// minutes, a dozen in an hour. One pacer can serve several progress sources (the ortho's
// blocks and its map visits): whichever speaks, the next line waits for the next interval.
export function createLogPacer({ everyMs = 30_000, maxMs = 300_000, now = () => performance.now() } = {}) {
  let last = now(), wait = everyMs
  return {
    now,
    due: () => now() - last >= wait,
    spoke() { last = now(); wait = Math.min(maxMs, wait * 2) },
  }
}

// The log's record of a long loop over blocks (the tiled ortho: hundreds of blocks at
// up to minutes each). The progress bar moves, but a run left alone for hours needs
// lines in the log that say it is alive and how far it has got.
//
// `finished()` is called once per block. It returns a log line after the first block
// (the first time per block is the first estimate), then when the pacer allows, and
// never after the last block, where the caller logs its own summary. `label()` is the
// progress-bar label for the block now running.
export function createBlockProgress(total, { prefix = '', pacer = null, now = () => performance.now() } = {}) {
  const pace = pacer ?? createLogPacer({ now })
  const t0 = pace.now()
  let done = 0
  return {
    label: () => `block ${Math.min(done + 1, total)} of ${total}`,
    finished() {
      done++
      if (done >= total) return null
      if (done > 1 && !pace.due()) return null
      pace.spoke()
      const elapsed = (pace.now() - t0) / 1000
      const per = elapsed / done
      return `${prefix}${done} of ${pluralize(total, 'block')} done (${Math.floor(100 * done / total)}%) `
        + `in ${formatClock(elapsed)}, ${per.toFixed(per < 10 ? 1 : 0)} s per block, `
        + `${remainingText(per * (total - done))} left`
    },
  }
}

// "about 7 minutes", but plain "less than a minute": an estimate under a minute is
// already a bound.
function remainingText(secs) {
  const t = formatRemaining(secs)
  return t.startsWith('less than') ? t : `about ${t}`
}

// A heartbeat for work counted in steps rather than blocks (the ortho's map visits, which
// keep coming while a group of blocks is still open): `step(done, total, what)` returns a
// line when the pacer allows, else null. The time left is the overall rate since start.
export function createStepProgress({ prefix = '', unit = 'step', pacer = null, now = () => performance.now() } = {}) {
  const pace = pacer ?? createLogPacer({ now })
  const t0 = pace.now()
  return {
    step(done, total, what = '') {
      if (done <= 0 || done >= total || !pace.due()) return null
      pace.spoke()
      const elapsed = (pace.now() - t0) / 1000
      return `${prefix}${what ? `${what} — ` : ''}${done.toLocaleString()} of ${total.toLocaleString()} ${nounFor(total, unit)} `
        + `(${Math.floor(100 * done / total)}%) in ${formatClock(elapsed)}, ${remainingText(elapsed / done * (total - done))} left`
    },
  }
}
