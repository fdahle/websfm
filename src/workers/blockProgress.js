import { formatClock, formatRemaining } from '../utils/timeFormat.js'
import { pluralize } from '../core/textFormat.js'

// The log's record of a long loop over blocks (the tiled ortho: hundreds of blocks at
// up to minutes each). The progress bar moves, but a run left alone for hours needs
// lines in the log that say it is alive and how far it has got.
//
// `finished()` is called once per block. It returns a log line after the first block
// (the first time per block is the first estimate), then at most once per `everyMs`,
// and never after the last block, where the caller logs its own summary. `label()`
// is the progress-bar label for the block now running.
export function createBlockProgress(total, { prefix = '', everyMs = 30_000, now = () => performance.now() } = {}) {
  const t0 = now()
  let done = 0
  let lastLine = -Infinity
  return {
    label: () => `block ${Math.min(done + 1, total)} of ${total}`,
    finished() {
      done++
      const t = now()
      if (done >= total) return null
      if (done > 1 && t - lastLine < everyMs) return null
      lastLine = t
      const elapsed = (t - t0) / 1000
      const per = elapsed / done
      return `${prefix}${done} of ${pluralize(total, 'block')} done (${Math.floor(100 * done / total)}%) `
        + `in ${formatClock(elapsed)}, ${per.toFixed(per < 10 ? 1 : 0)} s per block, `
        + `about ${formatRemaining(per * (total - done))} left`
    },
  }
}
