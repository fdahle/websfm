// Where a matching run's passes sit on the progress bar.
//
// The pair pass is followed by passes whose size is known only when they start: the
// gate rescue (its pairs are the gated ones of weakly connected images) and up to
// `bridgeRounds` rounds of bridge repair. The bar never moves back, so a pass that
// reports against the pair count once the pair pass has filled it shows nothing and
// the progress dialog drops its time estimate. Instead the pair pass stops at
// 1 − postShare when a later pass can run, and each later pass takes a share of what
// is left (the last one that can run takes all of it): the rescue 4/5, as it can hold
// hundreds of pairs where a bridge round holds at most bridgeMaxPairs, and each bridge
// round half. A pass that does not run leaves its part to the end of the run.

/** End of the pair pass on the bar: 1 when no later pass can run. */
export function pairPassEnd({ rescue, bridgeRounds, postShare }) {
  return rescue || bridgeRounds > 0 ? 1 - postShare : 1
}

/** The span a later pass fills, from where the bar stands when it starts. */
export function laterPassSpan(start, last, share = 0.5) {
  return [start, last ? 1 : start + (1 - start) * share]
}

/** Bar value after `k` of a pass's `n` items, the pass filling `span`. */
export function spanFraction([from, to], k, n) {
  return from + (to - from) * (n > 0 ? Math.min(1, k / n) : 1)
}
