import { ref } from 'vue'

export function useTheme() {
  const theme = ref(localStorage.getItem('theme') || 'dark')

  function applyTheme(t) {
    if (t === 'light') document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')
  }

  function setTheme(t) {
    theme.value = t
    applyTheme(t)
    localStorage.setItem('theme', t)
  }

  return { theme, applyTheme, setTheme }
}
