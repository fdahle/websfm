// Debug ▸ Flags (components/modals/app/FlagsModal.vue), the status bar's flags marker
// (components/layout/FlagsMarker.vue) and the note the Quality Report and the Project
// Summary show (components/layout/FlagsNote.vue). The flags' names, values and help are
// code (tuning.js) and stay English, as in the console.
export default {
  title: 'Flags',
  ariaLabel: 'Flags: internal tuning values',
  changed: '{n, plural, =0 {No flags changed} one {# flag changed} other {# flags changed}}',
  intro:
    'The internal values WebSfM is tuned with, for testing. Changing one changes your results, and nothing here ' +
    'is checked as a dialog checks its settings. The settings to choose for a project are in the dialogs. ' +
    'A change applies to the next run; it is not saved with the project.',
  search: { placeholder: 'Search names and help…', label: 'Search the flags' },
  tree: {
    label: 'Groups',
    group: { sfm: 'Sparse Model', match: 'Match Features' },
    other: 'Other',
    changedTip: '{n, plural, one {# flag changed} other {# flags changed}} here',
  },
  results: '{n, plural, =0 {No flag matches the search} one {# match} other {# matches}}',
  col: { name: 'Name', value: 'Value', default: 'Default', type: 'Type' },
  type: { number: 'number', boolean: 'on/off', text: 'text', choice: 'choice', list: 'list (JSON)' },
  auto: 'automatic',
  autoHint: 'empty: automatic',
  reset: 'Reset',
  resetTip: 'Back to the default, {value}',
  resetAll: 'Reset all',
  resetAllTip: 'Every flag back to its default',
  resetAllNone: 'No flag is changed',
  confirm: {
    title: 'Reset all flags?',
    message: '{n, plural, one {The changed flag goes} other {All # changed flags go}} back to the default.',
  },
  keep: 'Keep after reload (this browser only)',
  keepTip:
    'Store the changed flags in this browser, so they are still in effect after a reload. They are never saved with the project.',
  help: {
    title: 'From tuning.js',
    none: 'Select a row to read the comment above it in tuning.js.',
    missing: 'tuning.js has no comment for this value.',
    shared: 'The comment for {key}, which this value shares:',
  },
  invalid: {
    number: 'Enter a finite number',
    numberOrEmpty: 'Enter a finite number, or leave it empty for automatic',
    text: 'Enter a value',
    list: 'Enter a JSON list such as {example}',
    refused: 'Refused: {reason}',
  },
  marker: {
    label: '{n, plural, one {# flag changed} other {# flags changed}}',
    tip: 'Internal tuning values are changed, so results may differ from the defaults. Click to open Other ▸ Debug ▸ Flags.',
  },
  note: {
    text: '{n, plural, one {An internal tuning value is changed} other {# internal tuning values are changed}} (Other ▸ Debug ▸ Flags); a run made with them says so in its log:',
    item: '{key}={value} (default {def})',
  },
}
