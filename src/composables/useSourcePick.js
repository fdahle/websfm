import { computed, ref, unref } from 'vue'

// The cloud / mesh a tool dialog acts on (Tools ▸ Point Cloud ▾ / Mesh ▾, Build Mesh,
// Filter Cloud, …), and — called a second time with `exclude` — the reference it is
// compared with (Align to Reference, Distance to Reference).
//
// `id` is a writable computed for the dialog's <select v-model>. It reads the user's
// pick while that pick is still among the options, and otherwise the first option —
// so it is never a stale id that leaves the select blank and Run disabled:
//   - a reference picker whose `exclude` is the source re-picks a different item
//     when the user moves the current reference into the source slot (and returns
//     to the user's reference once it is allowed again);
//   - an item removed while the dialog is open falls back to the first one left.
// `initialId` is read once, at creation (the selection the dialog was opened from);
// an id that is not among the items is ignored.
//
//   items      array, ref/computed or getter of `{ id, … }`
//   initialId  value, ref or getter
//   exclude    value, ref or getter: an id never offered (the other slot's pick)
const read = (v) => (typeof v === 'function' ? v() : unref(v))

export function useSourcePick(items, { initialId = null, exclude = null } = {}) {
  const chosen = ref(read(initialId) ?? null)
  const options = computed(() => {
    const skip = read(exclude)
    const list = read(items) ?? []
    return skip == null ? list : list.filter((it) => it.id !== skip)
  })
  const id = computed({
    get: () => (options.value.some((it) => it.id === chosen.value) ? chosen.value : options.value[0]?.id ?? null),
    set: (v) => { chosen.value = v },
  })
  const item = computed(() => options.value.find((it) => it.id === id.value) ?? null)
  return { id, item, options }
}

// Option labels shared by the pickers (what each dialog's <option> text has always read).
const n = (v) => (v ?? 0).toLocaleString()
/** "Name — 1,234 points" */
export const cloudOptionLabel = (c) => `${c.name} — ${n(c.count)} points`
/** "Name — 1,234 triangles" (a mesh's `count` is its triangle count) */
export const meshOptionLabel = (m) => `${m.name} — ${n(m.count)} triangles`
/** A reference: a cloud by name, a mesh marked " (mesh)". */
export const referenceOptionLabel = (c) => `${c.name}${c.kind === 'mesh' ? ' (mesh)' : ''}`
