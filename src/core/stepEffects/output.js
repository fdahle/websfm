// The Output step of a build dialog (Dense Cloud, Mesh, DEM, Orthophoto): where the
// new product goes. By default it is added beside the existing ones and becomes the
// main one; Replace puts it in the main one's place (core/products/productSet.js).

/**
 * @param {boolean} replace the dialog's Replace option
 * @param {{ main: string|null, replaceable: boolean, newName: string }} plan the store's
 *   outputPlan(kind): the main product's name (null when there is none yet), whether
 *   a build may replace it (an imported or derived cloud is never replaced), and the
 *   name a new one gets
 * @param {string} noun the product, lower case ("DEM", "dense cloud")
 * @returns {{ effect: string, inactive: boolean }}
 */
export function outputEffect(replace, plan, noun) {
  if (!plan?.main) return { effect: `The first ${noun}: "${plan?.newName ?? noun}"`, inactive: true }
  if (replace && plan.replaceable)
    return {
      effect: `Replaces "${plan.main}"; products built on it are kept, marked outdated`,
      inactive: false,
    }
  if (replace)
    return {
      effect: `"${plan.main}" is not one the pipeline built, so it stays: adds "${plan.newName}" as the main ${noun}`,
      inactive: false,
    }
  return { effect: `Adds "${plan.newName}" as the main ${noun}; "${plan.main}" stays`, inactive: false }
}
