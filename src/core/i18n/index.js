// UI text by language. Code never writes a user-visible sentence itself: it names a
// message, `msg('filterCloud.effect.sor', { k: 12 })`, and the UI renders that in the
// user's language (`composables/useI18n.js`). The messages are ICU MessageFormat
// (plurals, selects, `{n, number}` in the language's own digits) in one catalogue per
// language and area, `core/i18n/<lang>/<area>.js`. A message a language lacks falls
// back to English, so a partial translation still runs.
//
// Pure on purpose: a message is plain data, so core and the workers can return one, and
// a worker's message crosses postMessage as it is. Logs and bug reports render in
// English (`render(m)` without a language), so a report reads the same to us whatever the
// user's language.
import { IntlMessageFormat } from 'intl-messageformat'
import en from './en/index.js'
import de from './de/index.js'

// language id → { dotted key → ICU message }. Add a language here with its catalogue.
export const CATALOGS = { en: flatten(en), de: flatten(de) }
// A `preview` language is partly translated: it is never picked from the browser's
// languages, only chosen by hand (the console's `lang`), until it covers the app.
export const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch', preview: true },
]
export const FALLBACK = 'en'

// Nested catalogue objects → { 'area.group.name': message }.
export function flatten(tree, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else flatten(v, key, out)
  }
  return out
}

// A message: its catalogue key and its parameters. A parameter may be a number (the
// message formats it), a string (left as it is: a unit, a name), another message, or an
// array of them (joined as a list: "a, b and c").
export const msg = (key, params) => (params ? { key, params } : { key })
export const isMsg = (v) => v != null && typeof v === 'object' && typeof v.key === 'string'

// Inline tags a message may hold, as rich text: the UI draws them (`I18nText.vue`),
// plain rendering drops the tag and keeps its text.
export const RICH_TAGS = ['strong', 'em', 'code', 'kbd']
const PLAIN_TAGS = Object.fromEntries(RICH_TAGS.map((t) => [t, (chunks) => chunks.join('')]))

const compiled = new Map()
function formatter(key, locale, catalogs) {
  const lang = catalogs[locale]?.[key] != null ? locale : FALLBACK
  const source = catalogs[lang]?.[key]
  if (source == null) return null
  const id = `${lang}\u0000${key}`
  let f = catalogs === CATALOGS ? compiled.get(id) : null
  if (!f) {
    f = new IntlMessageFormat(source, lang)
    if (catalogs === CATALOGS) compiled.set(id, f)
  }
  return f
}

function params(p, locale, catalogs, tags) {
  if (!p) return tags
  const out = { ...tags }
  for (const [k, v] of Object.entries(p)) out[k] = param(v, locale, catalogs)
  return out
}
function param(v, locale, catalogs) {
  if (isMsg(v)) return render(v, locale, catalogs)
  if (Array.isArray(v))
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(v.map((x) => String(param(x, locale, catalogs))))
  return v ?? ''
}

// A message (or a plain string, passed through) → its text in `locale`. A key no
// catalogue has renders as the key itself, so a gap shows instead of vanishing (the unit
// tests check every key the code uses).
export function render(m, locale = FALLBACK, catalogs = CATALOGS) {
  if (!isMsg(m)) return m ?? ''
  const f = formatter(m.key, locale, catalogs)
  if (!f) return m.key
  const out = f.format(params(m.params, locale, catalogs, PLAIN_TAGS))
  return Array.isArray(out) ? out.join('') : String(out)
}

// The same, keeping inline tags: an array of strings and { tag, children } parts.
// `extraTags` names more tags the caller draws itself (I18nText's slots: a link or a
// button inside a sentence, `Import as <pose>{pose}</pose>`).
export function renderRich(m, locale = FALLBACK, catalogs = CATALOGS, extraTags = []) {
  if (!isMsg(m)) return [m ?? '']
  const f = formatter(m.key, locale, catalogs)
  if (!f) return [m.key]
  const tags = Object.fromEntries([...RICH_TAGS, ...extraTags].map((tag) => [tag, (children) => ({ tag, children })]))
  const out = f.format(params(m.params, locale, catalogs, tags))
  return Array.isArray(out) ? out : [out]
}

// Every value of an object rendered, `{ short, long }` pairs included: what a dialog's
// step effects come back as.
export function renderAll(obj, locale = FALLBACK, catalogs = CATALOGS) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      v && typeof v === 'object' && !isMsg(v) && ('short' in v || 'long' in v)
        ? { short: render(v.short, locale, catalogs), long: render(v.long, locale, catalogs) }
        : render(v, locale, catalogs)
  }
  return out
}
