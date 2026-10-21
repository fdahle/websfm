import { ref } from 'vue'

// The browser's online/offline state as a shared ref. `navigator.onLine === false`
// is reliable (no network interface); `true` only means "maybe", so callers that
// need certainty still watch their own requests fail (see ViewerMap's tile status).
//
// Module-level singleton: one pair of window listeners for the whole app.

export const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false)

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    online.value = true
  })
  window.addEventListener('offline', () => {
    online.value = false
  })
}
