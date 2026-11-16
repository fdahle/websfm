// The Output step of a build dialog (Dense Cloud, Mesh, DEM, Orthophoto): where the
// new product goes. By default it is added beside the existing ones and becomes the
// main one; Replace puts it in the main one's place (core/products/productSet.js).
// Messages (core/i18n): the words are in core/i18n/<lang>/dialog.js ▸ output.
import { msg } from '../i18n/index.js'

/**
 * @param {boolean} replace the dialog's Replace option
 * @param {{ main: string|null, replaceable: boolean, newName: string }} plan the store's
 *   outputPlan(kind): the main product's name (null when there is none yet), whether
 *   a build may replace it (an imported or derived cloud is never replaced), and the
 *   name a new one gets
 * @param {'dem'|'ortho'|'mesh'|'dense'} kind the product
 * @returns {{ effect: object, short: object, inactive: boolean }} — messages; `short` for the step chain
 */
export function outputEffect(replace, plan, kind) {
  const main = plan?.main,
    name = plan?.newName
  if (!main)
    return {
      effect: msg('dialog.output.effect.first', { kind, name: name ?? '' }),
      short: msg('dialog.output.short.first'),
      inactive: true,
    }
  if (replace && plan.replaceable)
    return {
      effect: msg('dialog.output.effect.replaces', { main }),
      short: msg('dialog.output.short.replaces', { main }),
      inactive: false,
    }
  return {
    effect: msg(replace ? 'dialog.output.effect.kept' : 'dialog.output.effect.adds', { kind, main, name }),
    short: msg('dialog.output.short.adds', { name }),
    inactive: false,
  }
}
