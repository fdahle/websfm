import { ref } from 'vue'

// Transient bottom-right confirmations for actions with no other visible effect.
//
// A clipboard write is the motivating case: it succeeds silently, so without
// feedback the only way to know whether it worked — and *what* landed there — is
// to paste somewhere and look. The toast therefore echoes the copied text
// verbatim rather than saying "Copied!".
//
// Module-level singleton (like useContextMenu's registry) so any component can
// raise a toast without threading a prop down from App.vue; a single
// <ToastStack /> mounted once renders them.

let nextId = 1
export const toasts = ref([]) // [{ id, title, detail, kind, timer }]

const DEFAULT_MS = 2600

export function dismissToast(id) {
  const i = toasts.value.findIndex((t) => t.id === id)
  if (i === -1) return
  clearTimeout(toasts.value[i].timer)
  toasts.value.splice(i, 1)
}

// kind: 'success' (default) | 'error'
export function showToast(title, { detail = '', kind = 'success', ms = DEFAULT_MS } = {}) {
  const id = nextId++
  const timer = setTimeout(() => dismissToast(id), ms)
  toasts.value.push({ id, title, detail, kind, timer })
  return id
}

// The one clipboard entry point. Every "Copy …" menu action goes through this so
// the write and its confirmation can never drift apart — and so a blocked
// clipboard (insecure context, denied permission) reports instead of failing
// silently, which is what the bare try/catch at each call site used to do.
export async function copyToClipboard(text, label = 'value') {
  try {
    await navigator.clipboard.writeText(text)
    showToast(`Copied ${label}`, { detail: text })
    return true
  } catch {
    showToast('Clipboard unavailable', { detail: text, kind: 'error', ms: 4000 })
    return false
  }
}
