import { shallowRef } from 'vue'

// What the user last submitted in the New Project dialog, kept only when that
// create FAILED. The lifecycle reopens the dialog on failure, and the dialog is a
// fresh v-if mount — without this a retry starts again from "My Project". Taken
// (and cleared) by the next mount, so a later, unrelated New Project opens on the
// defaults again. Module state: there is one New Project dialog.
const draft = shallowRef(null)

/** Remember a failed create's values ({ name, sceneType, crs, dirHandle }). */
export function rememberNewProjectDraft(values) {
  draft.value = values ? { ...values } : null
}

/** The dialog's initial values: the remembered draft (consumed) or the defaults. */
export function takeNewProjectDraft(defaults) {
  const d = draft.value
  draft.value = null
  if (!d) return { ...defaults }
  return {
    name: d.name || defaults.name,
    sceneType: d.sceneType || defaults.sceneType,
    // An object-capture create sends crs: null; the picker still needs a value.
    crs: d.crs || defaults.crs,
    dirHandle: d.dirHandle ?? null,
  }
}
