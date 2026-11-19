// Words many dialogs share. ICU MessageFormat: `{n, number}` formats a number in the
// user's language, `{n, plural, one {…} other {…}}` picks the form.
export default {
  off: 'off',
  enabled: 'Enabled',
  cancel: 'Cancel',
  min: 'min',
  max: 'max',
  units: 'units',
  source: 'Source',
  cloud: 'Cloud',
  reset: 'Reset',
  // A quality preset the user has changed a setting of.
  preset: { modified: '{preset} · modified' },
  // An item in a dialog's Source list; {tags} is " · main", " · outdated" or nothing.
  sourceOption: {
    cloud: '{name} — {count, plural, one {# point} other {# points}}{tags}',
    mesh: '{name} — {count, plural, one {# triangle} other {# triangles}}{tags}',
    reference: '{name}{tags}',
    referenceMesh: '{name} (mesh){tags}',
    main: 'main',
    outdated: 'outdated',
  },
  close: 'Close',
  nothingToShow: 'Nothing to show.',
  advanced: 'Advanced',
  showAdvanced: 'Show advanced settings',
  advancedHidden: '{n, plural, one {# advanced setting hidden} other {# advanced settings hidden}}',
  // Ctrl+S (app.save): WebSfM saves as you work, so the key waits for the writes and says so.
  save: {
    saved: 'All changes are saved: WebSfM saves as you work. Other ▸ Export Project writes a project file.',
    failed: 'Saving failed. The console says why.',
    noProject: 'No project is open.',
  },
  // A length in project units, three significant digits ("0.05 units", "1,230 m").
  length: '{v, number, ::@##} {unit}',
}
