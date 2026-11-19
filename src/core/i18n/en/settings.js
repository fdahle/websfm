// Settings (components/modals/app/SettingsModal.vue): the preferences of this browser,
// by tab and group. A row is { label, desc }; a select's options sit beside them.
export default {
  title: 'Settings',
  tab: {
    general: 'General',
    view: 'Map & 3D',
    compute: 'Compute',
    storage: 'Storage',
  },
  group: {
    appearance: 'Appearance',
    startup: 'On start',
    help: 'Help',
    editing: 'Editing',
    notices: 'Notices',
    map: 'Map',
    view3d: '3D view',
    resources: 'Resources',
    run: 'During a run',
    advanced: 'Advanced',
  },
  // A tab's advanced rows while Show advanced settings (the footer) is off.
  advancedHidden:
    '{n, plural, one {# advanced setting hidden} other {# advanced settings hidden}}: turn on Show advanced settings below.',

  theme: {
    label: 'Theme',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
    followsSystem: 'Follows your operating system, now {mode, select, light {light} other {dark}}.',
    fixed: 'Used throughout the app.',
  },
  motion: {
    label: 'Motion',
    desc: 'Follow the operating system, or keep the interface’s animation to a minimum.',
    system: 'Follow system',
    reduce: 'Reduce motion',
  },
  language: {
    label: 'Language',
    // The groups of the language list.
    full: 'Translated',
    partial: 'Partly translated',
    planned: 'Not translated yet',
    plannedReason: 'Not translated yet: planned for a later version',
    descFull: 'The language of menus, dialogs and help. Logs and console commands stay in English.',
    descPartial:
      'Partly translated: what is not translated yet shows in English. Logs and console commands stay in English.',
  },
  openLast: {
    label: 'Open the last project on start',
    desc: 'Open the project you worked on last when WebSfM starts, with the tabs it had open, instead of the project list. A project that did not finish opening the last time is not opened again.',
  },
  glossary: {
    label: 'Glossary terms',
    desc: 'Underline explained words and put a ? after settings with advice; hover for the explanation and a link to the full entry.',
  },
  confirmMark: {
    label: 'Confirm before removing a mark',
    desc: 'Ask before deleting a single image mark of a control point or marker.',
  },
  bugButton: {
    label: 'Bug report button',
    desc: 'Show the round button at the bottom right that opens a new GitHub issue. Other ▸ About links there too.',
  },
  browserWarning: {
    label: 'Warn on unsupported browser',
    desc: 'Remind me when this browser’s limits can affect processing or file access.',
  },
  mobileWarning: {
    label: 'Warn on mobile devices',
    desc: 'Show the notice that WebSfM is made for a desktop computer and its layout does not fit a phone.',
  },

  basemap: {
    label: 'Map base layer',
    desc: 'Automatic uses OpenStreetMap, and the matching NASA layer for a polar coordinate system. Satellite and Terrain are not available for polar systems.',
  },
  satellite: {
    label: 'Satellite imagery source',
    desc:
      'By default Satellite shows Esri World Imagery, under <terms>Esri’s terms of use</terms>: commercial use may ' +
      'need an ArcGIS account. To use a provider you hold a licence for, enter its XYZ tile URL with ' +
      "<code>'{z}'</code>, <code>'{x}'</code> and <code>'{y}'</code> (and your API key, if it needs one). It is kept " +
      'in this browser only.',
    urlPlaceholder: 'Esri World Imagery (default)',
    urlLabel: 'Satellite tile URL',
    attributionPlaceholder: 'Attribution, e.g. © Provider',
    attributionLabel: 'Satellite attribution',
    needsUrl: 'Enter a tile URL first',
    apply: 'Apply',
    noChanges: 'No changes to apply',
    useEsri: 'Use Esri',
    alreadyEsri: 'Already using Esri',
    // Why a tile URL was refused (core/basemaps.js tileUrlError).
    errorHttps: 'The URL must start with https://',
    errorPlaceholders: "The URL needs '{z}', '{x}' and '{y}' placeholders",
  },
  background: {
    label: '3D background',
    desc: 'A plain background for the 3D view, whatever the app’s theme.',
    theme: 'Follow theme',
    dark: 'Dark grey',
    light: 'Light grey',
    black: 'Black',
  },
  gridZ: {
    label: '3D ground-grid height',
    desc: 'Put the reference grid at the bottom, the middle or the top of the loaded point cloud.',
    min: 'Bottom',
    avg: 'Middle',
    max: 'Top',
  },
  nearClip: {
    label: '3D near clipping distance',
    desc: 'How close to the camera points are still drawn, in scene units. 0 adjusts it as you zoom; set a small distance when nearby points vanish.',
  },
  pointBudget: {
    label: '3D <glossary>point budget</glossary> (million points)',
    desc: 'Clouds of 4 million points or more are drawn with level of detail: at most this many points at once, with the most detail where you look. Lower it if orbiting stutters.',
  },

  memory: {
    label: 'Memory safety limit',
    desc: 'The memory the heavy steps (detection, depth maps, dense cloud, DEM, orthophoto) plan for: they split their work to stay under it, and refuse to start when they cannot. Raise it if the computer has more free memory and a step is refused; lower it if the tab crashes.',
    auto: 'Set automatically: {source, select, device {the computer reports {gb, number} GB of memory} heap {from the browser’s memory limit} other {the browser reports no memory, so a safe starting value}}.',
    manual: 'Set by hand.',
    unit: 'GB',
    autoButton: 'Auto',
    autoTip: 'Use the detected limit',
    autoActive: 'Already using the detected limit',
  },
  workers: {
    label: 'Compute workers',
    desc: 'How many images or blocks are processed at once. Fewer use less memory. Automatic uses up to {n, number} on this computer.',
    auto: 'Automatic ({n, number})',
  },
  gpu: {
    label: 'Use GPU',
    recommended: 'Recommended',
    desc: 'On when this browser offers WebGPU. Matching and the dense steps run on the graphics card where they can, else on the CPU.',
  },
  keepAwake: {
    label: 'Keep the screen on during a run',
    desc: 'Stop the display, and on most systems the computer, from going to sleep while a step or workflow runs. Works while the WebSfM tab is visible.',
  },
  notify: {
    label: 'Notify when a run ends',
    desc: 'A desktop notification when a run of 30 seconds or more ends, or a workflow needs you, while the WebSfM tab is in the background.',
    blocked: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn this on.',
    notGranted: 'The browser did not allow notifications. Turn this on again to be asked once more.',
  },

  storage: {
    label: 'Browser storage',
    desc: 'Projects kept in this browser, their derived files, downloaded AI models and anything else this site stores.',
    used: '{used} used of {quota} available to this site',
    unavailable: 'This browser does not report its storage use.',
    readFailed: 'Reading the storage use failed: {error}',
  },
  durable: {
    label: 'Storage protection',
    desc: 'Persistent storage makes the browser less likely to delete projects kept in it when the disk is nearly full. The browser decides this itself, usually without asking, by how often the site is used.',
    protected: 'Protected',
    request: 'Request',
    requesting: 'Requesting…',
    unavailable: 'Unavailable',
    busy: 'Wait for the storage request to finish',
    granted: 'Persistent storage is on.',
    declined:
      'The browser declined for now. Most browsers allow it on their own, without asking, once the site is used often, bookmarked or installed as an app. Projects still save normally, but may be deleted if the disk runs out of space. You can try again later.',
    failed: 'Requesting persistent storage failed: {error}',
  },
  models: {
    label: 'Downloaded AI models',
    none: 'None downloaded. A step that needs a model offers to download it.',
    some: 'Downloaded: {names}. Each downloads again only when a step needs it.',
    checking: 'Checking…',
    clear: 'Clear models',
    nothing: 'No models are downloaded',
    confirmTitle: 'Remove downloaded models?',
    confirmMessage:
      'Remove the downloaded AI models? They download again when a step needs them. Projects are not affected.',
    removed: 'The downloaded AI models were removed.',
    failed: 'Removing the downloaded models failed: {error}',
  },
}
