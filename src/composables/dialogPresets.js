import { shallowRef } from 'vue'
import * as opfs from '../utils/opfs.js'

// This browser's named dialog presets (`dialog-presets.json` beside the project index,
// { dialog: [{ name, settings }] }), read once and shared: every open dialog
// (useDialogSettings), Settings ▸ Storage ▸ Dialog presets and the settings export
// read the same object, so a preset renamed or deleted in one shows in the others.
// The list operations are core/dialogSettings.js's (withPreset, withoutPreset,
// renamePreset); this only reads and writes.

export const PRESETS_FILE = 'dialog-presets.json'

// null until the file has been read.
export const dialogPresets = shallowRef(null)
let reading = null

/** The presets, read from storage the first time. */
export function loadDialogPresets() {
  if (dialogPresets.value) return Promise.resolve(dialogPresets.value)
  reading ??= opfs
    .readAppJson(PRESETS_FILE)
    .catch(() => null)
    .then((data) => {
      dialogPresets.value ??= data && typeof data === 'object' ? data : {}
      return dialogPresets.value
    })
  return reading
}

/** Put `next` in place of every preset, and write it. */
export async function writeDialogPresets(next) {
  dialogPresets.value = next
  await opfs.writeAppJson(PRESETS_FILE, next)
}
