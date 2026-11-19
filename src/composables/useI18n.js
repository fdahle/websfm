import { ref } from 'vue'
import { FALLBACK, LANGUAGES, msg, render, renderAll, renderRich } from '../core/i18n/index.js'

// The UI language, for this browser: the one chosen (Settings ▸ General ▸ Language, or
// the console's `lang`), else the first of the browser's languages WebSfM has in full (not a
// `preview` one), else English. Text in a template is `t('area.key',
// params)`; a message that came from core (a step effect, a preset card) is `tx(m)`,
// and a plain string passes through `tx` unchanged. Both read `locale`, so whatever
// shows them redraws when the language changes. Rich text (bold menu paths) goes
// through <I18nText>.
const STORAGE_KEY = 'uiLanguage'
const IDS = LANGUAGES.map((l) => l.id)

function initial() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (IDS.includes(stored)) return stored
  } catch {
    // Storage blocked: fall through to the browser's languages.
  }
  const wanted = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])
  const full = LANGUAGES.filter((l) => !l.preview).map((l) => l.id)
  return wanted.map((l) => String(l ?? '').slice(0, 2)).find((l) => full.includes(l)) ?? FALLBACK
}

const locale = ref(initial())
if (typeof document !== 'undefined') document.documentElement.lang = locale.value

export function setLanguage(id) {
  if (!IDS.includes(id)) return
  locale.value = id
  if (typeof document !== 'undefined') document.documentElement.lang = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Not remembered in this browser; the choice still holds until reload.
  }
}

export const t = (key, params) => render(msg(key, params), locale.value)
export const tx = (m) => render(m, locale.value)
export const txAll = (obj) => renderAll(obj, locale.value)
export const txRich = (m, extraTags) => renderRich(m, locale.value, undefined, extraTags)

export function useI18n() {
  return { locale, t, tx, txAll, txRich, setLanguage, languages: LANGUAGES }
}
