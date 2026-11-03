import { provide, inject, reactive, ref } from 'vue'
import { useUiSettings } from './useUiSettings.js'

// The steps of a processing dialog as groups (dev/planning/plan-dialog-layout.md): each
// step's header (number · title · short fact) opens and closes it; open, it shows what
// the step does and its everyday fields, and its advanced fields while the footer's Show
// advanced settings is on — seeded from (and saved as) Settings ▸ Display ▸ Expand
// advanced settings. A closed group shows none of them, whatever that switch says. A
// dialog calls provideStepLayout('<dialog id>'); SettingsStep and ShowAdvancedSettings
// inject it. Without it SettingsStep keeps its plain layout.
//
// A step the user opened or closed stays that way the next time the dialog opens, in
// this browser: OPEN_STEPS_KEY holds { dialogId: { step: open } }. A step never toggled
// follows its default (open when it has everyday fields).
const KEY = Symbol('stepLayout')
const OPEN_STEPS_KEY = 'websfm.ui.openSteps'

function readOpenSteps() {
  try {
    const all = JSON.parse(localStorage.getItem(OPEN_STEPS_KEY) || '{}')
    return all && typeof all === 'object' ? all : {}
  } catch {
    return {}
  }
}

function saveOpenSteps(dialogId, steps) {
  try {
    const all = readOpenSteps()
    all[dialogId] = { ...steps }
    localStorage.setItem(OPEN_STEPS_KEY, JSON.stringify(all))
  } catch {
    // Storage blocked or full: the toggle still works for this visit.
  }
}

export function provideStepLayout(dialogId = null) {
  const { advancedSettingsExpanded, setAdvancedSettingsExpanded } = useUiSettings()
  const stored = dialogId ? readOpenSteps()[dialogId] : null
  // The user's own choice per step (true open, false closed); a step without one
  // follows its default.
  const chosen = reactive(stored && typeof stored === 'object' ? { ...stored } : {})
  const byDefault = reactive(new Set())
  const showAdvanced = ref(!!advancedSettingsExpanded.value)
  const isOpen = (step) => {
    const k = String(step)
    return typeof chosen[k] === 'boolean' ? chosen[k] : byDefault.has(k)
  }
  const choose = (step, open) => {
    chosen[String(step)] = open
    if (dialogId) saveOpenSteps(dialogId, chosen)
  }
  const layout = {
    showAdvanced,
    setShowAdvanced(v) {
      showAdvanced.value = !!v
      setAdvancedSettingsExpanded(!!v)
    },
    isOpen,
    toggle: (step) => choose(step, !isOpen(step)),
    open: (step) => choose(step, true),
    // A step with everyday fields starts open unless the user closed it.
    startOpen: (step) => byDefault.add(String(step)),
  }
  provide(KEY, layout)
  return layout
}

export const useStepLayout = () => inject(KEY, null)
