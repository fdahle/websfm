// Import ▸ SfM Project (components/modals/import/InteropSourceModal.vue): which tool the
// files come from, and where they are. COLMAP and the other tools lead on to the
// interop import, Metashape to its own.
export default {
  title: 'Import SfM Project',
  format: { colmap: 'COLMAP', metashape: 'Metashape', other: 'Other SfM' },
  colmap: {
    hint: 'Choose a project ZIP or loose files, or a whole COLMAP workspace folder.',
    filesTitle: 'Files or ZIP',
    files: 'database.db, cameras / images / points3D (.txt or .bin), or a ZIP of them',
    folderTitle: 'Folder',
    folder: 'database, images/ and sparse/ together',
  },
  metashape: {
    hint: 'A project brings its tie points (keypoints, matches, the sparse model) and mesh as well; load the photos first.',
    xmlTitle: 'Cameras or markers XML',
    xml: "Metashape's Export Cameras or Export Markers (its File menu)",
    pszTitle: 'Project file',
    psz: 'a .psz, the project in one file',
    folderTitle: 'Project folder',
    folder: 'the folder that holds the .psx and its .files folder',
  },
  other: {
    hint: 'Bundler needs its bundle.out and the list.txt that names the images: pick both, or their folder.',
    filesTitle: 'Files or ZIP',
    files:
      'Bundler bundle.out + list.txt, VisualSFM .nvm, OpenMVG sfm_data.json, OpenSfM reconstruction.json, transforms.json',
    folderTitle: 'Folder',
    folder: 'a Bundler output folder (bundle/bundle.out and list.txt)',
  },
}
