import { ref } from 'vue'
import { defineStore } from 'pinia'

// State for the single Guide modal: a home/index tab plus one tab per opened
// operation. Mirrors useGlossaryStore, but tabs are operation ids and it carries
// an optional `focusParam` so opening from a field's `?` affordance scrolls the
// modal to that parameter's section. Deliberately separate from useModalsStore's
// action dialogs — browsing help shouldn't close the action modal it was opened
// from. Pure UI state: not persisted.
export const useGuideStore = defineStore('guide', () => {
  const isOpen = ref(false)
  const tabs = ref([])         // operation ids, in the order opened
  const activeId = ref('home') // 'home' or an operation id
  const focusParam = ref(null) // param key to scroll to after opening, or null

  // Open the modal on the home/index page.
  function openHome() {
    isOpen.value = true
    activeId.value = 'home'
    focusParam.value = null
  }

  // Open an operation: focus its tab if already open, else append a new one.
  // `param` (optional) tells GuideModal which section to scroll into view.
  function openOp(id, param = null) {
    if (!id) return
    isOpen.value = true
    if (!tabs.value.includes(id)) tabs.value = [...tabs.value, id]
    activeId.value = id
    focusParam.value = param
  }

  function setActive(id) {
    activeId.value = id
    focusParam.value = null
  }

  function closeTab(id) {
    const i = tabs.value.indexOf(id)
    if (i === -1) return
    tabs.value = tabs.value.filter(t => t !== id)
    if (activeId.value === id) activeId.value = tabs.value[i - 1] ?? tabs.value[i] ?? 'home'
  }

  function close() {
    isOpen.value = false
  }

  return { isOpen, tabs, activeId, focusParam, openHome, openOp, setActive, closeTab, close }
})
