import { inject, provide } from 'vue'

// What App.vue composes (the feature composables' state and handlers) for the
// dialog hosts under it, handed down once rather than as props: ProjectModals,
// PipelineModals and DataModals read store state from the stores and the rest from
// here. Values are the composables' own refs and functions, so a host destructures
// them into top-level bindings and its template reads and writes them as usual.
const KEY = Symbol('app')

export function provideAppContext(context) {
  provide(KEY, context)
}

export function useAppContext() {
  const context = inject(KEY, null)
  if (!context) throw new Error('useAppContext() needs provideAppContext() in an ancestor')
  return context
}
