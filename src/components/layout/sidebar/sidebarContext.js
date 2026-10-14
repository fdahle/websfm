import { inject, provide, reactive } from 'vue'

// What the sidebar sections need from App.vue, handed down once instead of as
// props and events relayed through Sidebar.vue. Store data the sections read from
// the stores themselves; this carries the rest:
//   • App-level derived state (the GCP report, which tabs are open, …) — refs or
//     computeds, unwrapped by the reactive wrapper, so `sidebar.openTabIds.has(…)`.
//   • Actions — what a row's click or menu item does. Many are App-level on
//     purpose: removals go through the shared confirm dialog, opens go through
//     the tab strip. Each takes the payload the section used to emit.
const KEY = Symbol('sidebar')

export function provideSidebar(context) {
  provide(KEY, reactive(context))
}

export function useSidebar() {
  const sidebar = inject(KEY, null)
  if (!sidebar) throw new Error('useSidebar() needs provideSidebar() in an ancestor')
  return sidebar
}
