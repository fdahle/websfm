import { ref } from 'vue'

// Whether inline glossary terms are highlighted + hoverable in the UI. Persisted
// to localStorage (like useTheme) so it survives reloads. A single shared ref so
// every GlossaryTerm and the Settings toggle read/write the same state.
const STORAGE_KEY = 'glossaryTermsEnabled'
const enabled = ref(localStorage.getItem(STORAGE_KEY) !== 'false') // default on

export function useGlossarySettings() {
  function setEnabled(v) {
    enabled.value = !!v
    localStorage.setItem(STORAGE_KEY, String(!!v))
  }
  return { glossaryTermsEnabled: enabled, setGlossaryTermsEnabled: setEnabled }
}
