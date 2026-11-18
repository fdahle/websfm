// About (components/modals/app/AboutModal.vue), its Version block (VersionsPanel.vue),
// and the badges beside the app's name (layout/BetaBadge.vue).
export default {
  title: 'About',
  tagline: 'Browser-based Structure from Motion · v{version}',
  tab: {
    about: 'About',
    credits: 'Acknowledgments',
    references: 'References',
    licenses: 'Licenses',
  },
  lede:
    'A complete photogrammetry pipeline — detection, matching, sparse & dense reconstruction, meshing and ' +
    'orthophotos — that runs entirely in your browser. No server, no upload: your images never leave your machine.',
  github: 'GitHub',
  reportBug: 'Report a bug',
  mitLicense: 'MIT License',
  creditsLede: 'WebSfM stands on decades of open research and software. Its methods draw on:',
  referencesLede:
    'The published methods WebSfM implements, each with the glossary entries that explain what it is used for. ' +
    'Each glossary entry lists them under Sources; the Quality Report lists those a project’s run used.',
  usedFor: 'Used for:',
  licensesLede:
    'WebSfM is released under the MIT License. It includes the software, models and data below, which others ' +
    'made and which keep their own licenses. All of them in one file:',
  noticesFailed: 'The list could not be loaded. It ships with the app as THIRD_PARTY_NOTICES.txt.',
  tryAgain: 'Try again',
  loading: 'Loading…',
  licenseText: '{n, plural, one {License text} other {License texts (#)}}',
  versions: {
    heading: 'Version',
    newest: 'WebSfM {version}, the newest version. It updates itself when a new version comes out.',
    pinned:
      'WebSfM {version}, pinned: it stays exactly as it is when WebSfM is updated, so a result can be made ' +
      'again with the same version.',
    pinThis: 'Keep using {version}',
    pinThisTitle: 'Opens {version} at its own address, which never changes. Bookmark it to stay on {version}.',
    openNewest: 'Open the newest version',
    others: 'Other versions:',
    shared:
      'All versions share your projects. A version does not open a project a newer one has opened: saving it ' +
      'there could lose what the newer one added.',
  },
  badge: {
    beta: 'Beta',
    betaTitle:
      'WebSfM is in beta: features and the project format still change between versions. Keep your source images.',
    pinned: 'Pinned',
    pinnedTitle: 'WebSfM {version}, pinned: it stays as it is when WebSfM is updated. About shows the other versions.',
  },
}
