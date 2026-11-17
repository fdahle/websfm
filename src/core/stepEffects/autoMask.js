// What each step of Auto Mask does to these photos (AutoMaskModal.vue): the edges, the
// text, then how the result meets a mask a photo already has, in the order
// composables/useAutoMaskRun.js runs them. Each line is a message (core/i18n); its words
// are in core/i18n/<lang>/autoMask.js.
import { msg } from '../i18n/msg.js'

const SIDES = ['top', 'right', 'bottom', 'left']
const OFF = msg('common.off')

// The strip's four sides as message params, and whether they agree.
const sidesOf = (s) => {
  const v = SIDES.map((k) => Math.max(0, s.sides?.[k] || 0))
  return {
    even: v.every((x) => x === v[0]),
    zero: v.every((x) => !x),
    p: Object.fromEntries(SIDES.map((k, i) => [k, v[i]])),
  }
}

// project: { photos (of known size), unsized (of unknown size, skipped), unread (photos
//            whose text is not read yet), masked (photos that have a mask) }
export function autoMaskEffects(s, { photos = 0, unsized = 0, unread = 0, masked = 0 } = {}) {
  const n = photos
  const withUnsized = (line) => (unsized ? msg('autoMask.effect.unsized', { line, k: unsized }) : line)
  let edges
  if (s.edges === 'strip') {
    const { even, zero, p } = sidesOf(s)
    edges = zero
      ? msg('autoMask.effect.edges.stripZero')
      : withUnsized(
          even
            ? msg('autoMask.effect.edges.stripEven', { px: p.top, n })
            : msg('autoMask.effect.edges.strip', { ...p, n }),
        )
  } else if (s.edges === 'frame') edges = withUnsized(msg('autoMask.effect.edges.frame', { n, inset: s.frameInset }))
  else edges = msg('autoMask.effect.edges.off')

  const text = s.text
    ? withUnsized(
        msg(s.textRecurring ? 'autoMask.effect.text.onRecurring' : 'autoMask.effect.text.on', {
          n,
          unread,
          pad: s.textPad,
        }),
      )
    : msg('autoMask.effect.text.off')

  const existing = !masked
    ? msg('autoMask.effect.existing.none')
    : msg(s.existing === 'replace' ? 'autoMask.effect.existing.replace' : 'autoMask.effect.existing.merge', {
        m: masked,
      })
  return { edges, text, existing }
}

// The steps' short facts for Auto Mask's step chain (≤ SHORT_MAX characters).
export function autoMaskShorts(s) {
  let edges = OFF
  if (s.edges === 'strip') {
    const { even, zero, p } = sidesOf(s)
    if (!zero)
      edges = even ? msg('autoMask.short.edges.stripEven', { px: p.top }) : msg('autoMask.short.edges.strip', p)
  } else if (s.edges === 'frame') edges = msg('autoMask.short.edges.frame', { inset: s.frameInset })
  return {
    edges,
    text: s.text
      ? msg(s.textRecurring ? 'autoMask.short.text.onRecurring' : 'autoMask.short.text.on', { pad: s.textPad })
      : OFF,
    existing: msg(s.existing === 'replace' ? 'autoMask.short.existing.replace' : 'autoMask.short.existing.merge'),
  }
}

/** Whether the settings mask anything at all (Run is disabled otherwise). */
export function autoMaskDoesSomething(s) {
  return !!s.text || s.edges === 'frame' || (s.edges === 'strip' && !sidesOf(s).zero)
}
