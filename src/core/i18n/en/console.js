// The console panel (components/layout/DevConsole.vue): its tabs, buttons and filter.
// The log lines and the command replies stay in English (docs/conventions.md ▸ Text in
// the UI), so they are not here.
export default {
  tab: {
    pipeline: 'Pipeline',
    activity: 'Activity',
    all: 'All',
  },
  source: {
    label: 'src',
    title: 'Show or hide the source of each line',
  },
  detail: {
    label: 'Detail',
    title: 'Show the detailed (debug) lines: one per image, pair or iteration',
  },
  filter: {
    label: 'Filter',
    title: 'Show only some sources',
    heading: 'Sources',
    all: 'All',
    none: 'None',
    empty: 'No sources yet.',
  },
  save: {
    label: 'Save TXT',
    title: 'Save the log to a TXT file',
    options: 'Export options',
    include: 'Include in export',
    activity: 'Activity (your edits)',
    debug: 'Detailed (debug) lines',
  },
  clear: {
    label: 'Clear',
    title: 'Clear the log, after asking',
    confirmTitle: 'Clear the console?',
    confirmMessage:
      "Delete every line of this project's log, the saved copy included? Save TXT keeps a copy first. This can't be undone.",
  },
  activity: {
    glyph: 'Your edit',
    command: 'Your edit. The console command for it: {command}',
  },
  empty: {
    none: 'No output yet.',
    activity: 'No activity yet: the edits you make appear here.',
    filtered: 'No lines match the current filter.',
  },
  jump: {
    label: '↓ New lines',
    title: 'Jump to the newest lines',
  },
  prompt: 'Type a command, or "help"',
}
