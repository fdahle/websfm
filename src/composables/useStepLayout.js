import { provide, inject, reactive, ref } from 'vue'
import { useUiSettings } from './useUiSettings.js'

// The steps of a processing dialog as groups (dev/planning/plan-dialog-layout.md): each
// step's header (number · title · short fact) opens and closes it; open, it shows what
// the step does and its everyday fields, and its advanced fields while the footer's Show
// advanced settings is on — seeded from (and saved as) Settings ▸ Display ▸ Expand
// advanced settings. A closed group shows none of them, whatever that switch says. A
// dialog calls provideStepLayout(); SettingsStep and ShowAdvancedSettings inject it.
// Without it SettingsStep keeps its plain layout.
const KEY = Symbol('stepLayout')

export function provideStepLayout() {
  const { advancedSettingsExpanded, setAdvancedSettingsExpanded } = useUiSettings()
  const opened = reactive(new Set())
  const seen = new Set()
  const showAdvanced = ref(!!advancedSettingsExpanded.value)
  const layout = {
    showAdvanced,
    setShowAdvanced(v) {
      showAdvanced.value = !!v
      setAdvancedSettingsExpanded(!!v)
    },
    isOpen: (step) => opened.has(String(step)),
    toggle(step) {
      const k = String(step)
      if (opened.has(k)) opened.delete(k)
      else opened.add(k)
    },
    open: (step) => opened.add(String(step)),
    // A step with everyday fields starts open, once: the user's toggle wins after.
    startOpen(step) {
      const k = String(step)
      if (seen.has(k)) return
      seen.add(k)
      opened.add(k)
    },
  }
  provide(KEY, layout)
  return layout
}

export const useStepLayout = () => inject(KEY, null)
