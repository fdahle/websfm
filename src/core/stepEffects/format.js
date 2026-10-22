// Number formatting shared by the step effects (core/stepEffects/*): grouped
// thousands, the same in every locale, so a line reads the same everywhere.

export const fmtCount = (n) => Number(n).toLocaleString('en-US')

// "1 image", "2 images", "1,204 images".
export const plural = (n, word, many = `${word}s`) => `${fmtCount(n)} ${n === 1 ? word : many}`

// A length with its unit, rounded to what matters at that size.
export const fmtLength = (v, unit) => `${Number(v.toPrecision(3)).toLocaleString('en-US')} ${unit}`
