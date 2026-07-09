import { onMounted, onBeforeUnmount } from 'vue'

// Site-wide "are you sure you want to leave?" guard on tab close / reload /
// navigation away. Modern browsers ignore any custom message and show their own
// generic confirm — all we can do is opt in by calling preventDefault + setting
// returnValue. Browsers only actually show it once the user has interacted with
// the page (sticky activation), so a pristine fresh load won't nag.
export function useBeforeUnload() {
  function onBeforeUnload(e) {
    e.preventDefault()
    // Legacy field some browsers still require to trigger the prompt.
    e.returnValue = ''
    return ''
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
}
