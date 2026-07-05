import { ref } from 'vue'
import { defineStore } from 'pinia'

// State for the single glossary modal: a home/index tab plus an unlimited set
// of term tabs. Clicking a glossary term's "Read more" or a cross-link inside
// the modal opens (or focuses) a tab. Deliberately separate from
// useModalsStore's action dialogs — browsing help shouldn't close whatever
// action modal the user opened it from. Pure UI state: not persisted.
export const useGlossaryStore = defineStore('glossary', () => {
  const isOpen = ref(false)
  const tabs = ref([])        // term entry ids, in the order opened
  const activeId = ref('home') // 'home' or an entry id

  // Open the modal on the home/index page.
  function openHome() {
    isOpen.value = true
    activeId.value = 'home'
  }

  // Open a term: focus its tab if already open, else append a new one.
  function openTerm(id) {
    if (!id) return
    isOpen.value = true
    if (!tabs.value.includes(id)) tabs.value = [...tabs.value, id]
    activeId.value = id
  }

  function setActive(id) {
    activeId.value = id
  }

  function closeTab(id) {
    const i = tabs.value.indexOf(id)
    if (i === -1) return
    tabs.value = tabs.value.filter(t => t !== id)
    // If the closed tab was active, fall back to its left neighbour or home.
    if (activeId.value === id) activeId.value = tabs.value[i - 1] ?? tabs.value[i] ?? 'home'
  }

  function close() {
    isOpen.value = false
  }

  return { isOpen, tabs, activeId, openHome, openTerm, setActive, closeTab, close }
})
