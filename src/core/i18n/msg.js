// Making a message, without the catalogues: what core and the workers need to return
// one (core/i18n/index.js renders it). Kept apart so a worker that only names messages
// does not bundle every language.
export const msg = (key, params) => (params ? { key, params } : { key })
export const isMsg = (v) => v != null && typeof v === 'object' && typeof v.key === 'string'
