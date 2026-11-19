export default {
  title: 'SfM-Projekt importieren',
  format: { colmap: 'COLMAP', metashape: 'Metashape', other: 'Andere SfM' },
  colmap: {
    hint: 'Ein Projekt-ZIP oder einzelne Dateien wählen, oder einen ganzen COLMAP-Workspace-Ordner.',
    filesTitle: 'Dateien oder ZIP',
    files: 'database.db, cameras / images / points3D (.txt oder .bin), oder ein ZIP davon',
    folderTitle: 'Ordner',
    folder: 'database, images/ und sparse/ zusammen',
  },
  metashape: {
    hint:
      'Ein Projekt bringt auch seine Verknüpfungspunkte (Keypoints, Matches, das Sparse-Modell) und sein Mesh mit; ' +
      'zuerst die Fotos laden.',
    xmlTitle: 'Kameras- oder Marker-XML',
    xml: 'Export Cameras oder Export Markers aus Metashape (sein Menü File)',
    pszTitle: 'Projektdatei',
    psz: 'eine .psz, das Projekt in einer Datei',
    folderTitle: 'Projektordner',
    folder: 'der Ordner mit der .psx und ihrem .files-Ordner',
  },
  other: {
    hint: 'Bundler braucht seine bundle.out und die list.txt, die die Bilder nennt: beide wählen, oder ihren Ordner.',
    filesTitle: 'Dateien oder ZIP',
    files:
      'Bundler bundle.out + list.txt, VisualSFM .nvm, OpenMVG sfm_data.json, OpenSfM reconstruction.json, transforms.json',
    folderTitle: 'Ordner',
    folder: 'ein Bundler-Ausgabeordner (bundle/bundle.out und list.txt)',
  },
}
