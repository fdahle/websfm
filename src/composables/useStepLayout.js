import { computed, provide, inject, reactive, ref, shallowReactive } from 'vue'
import { useUiSettings } from './useUiSettings.js'

// The steps of a processing dialog laid out once (dev/planning/plan-dialog-layout.md):
// a StepChain of short facts on top, only the steps with an everyday field drawn, each
// step's tuning folded in place behind "⚙ more". This holds which steps are open and
// the footer's Show all settings, seeded from (and saved as) Settings ▸ Display ▸
// Expand advanced settings. A dialog calls provideStepLayout(); SettingsStep, StepChain
// and ShowAllSettings inject it. Without it SettingsStep keeps its plain layout.
const KEY = Symbol('stepLayout')

export function provideStepLayout() {
  const { advancedSettingsExpanded, setAdvancedSettingsExpanded } = useUiSettings()
  const opened = reactive(new Set())
  const showAll = ref(!!advancedSettingsExpanded.value)
  // Every step the dialog renders registers itself here (SettingsStep): the chain lists
  // them in step order. A step the dialog leaves out (v-if on it) is not part of the run.
  const registry = shallowReactive(new Map()) // token → computed { step, title, short, long, inactive }
  const steps = computed(() =>
    [...registry.values()].map((r) => r.value).sort((a, b) => Number(a.step) - Number(b.step)),
  )
  const layout = {
    showAll,
    steps,
    register(token, info) {
      registry.set(token, info)
    },
    unregister(token) {
      registry.delete(token)
    },
    setShowAll(v) {
      showAll.value = !!v
      setAdvancedSettingsExpanded(!!v)
    },
    isOpen: (step) => showAll.value || opened.has(String(step)),
    toggle(step) {
      const k = String(step)
      if (opened.has(k)) opened.delete(k)
      else opened.add(k)
    },
    open: (step) => opened.add(String(step)),
  }
  provide(KEY, layout)
  return layout
}

export const useStepLayout = () => inject(KEY, null)
