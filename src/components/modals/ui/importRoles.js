/* Sizing for the per-column role <select> in the tabular import modals
   (CameraImportModal, GcpImportModal) — the JS half of `.role-select` in
   import-modal.css.

   The preview table sizes each column from its data cells ("3.14", "1"), which
   are far narrower than a role label ("Image X accuracy (px)"), so a select at
   width:100% clips whatever the user just picked. Reserve room for the SELECTED
   label only: the column grows with the choice, instead of every column being
   padded out to the widest option in the list. */

/** @param {string} roleId @param {{id:string,label:string}[]} options */
export function roleSelectStyle(roleId, options) {
  const label = options.find((o) => o.id === roleId)?.label ?? ''
  // ch is generous for a proportional font, and this is only a floor.
  // +34px ≈ horizontal padding + borders + the dropdown arrow.
  return { minWidth: `calc(${Math.max(label.length, 6)}ch + 34px)` }
}
