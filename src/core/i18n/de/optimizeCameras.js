// Deutsch: Kameras optimieren (en/optimizeCameras.js ist die Referenz).
export default {
  title: 'Kameras optimieren',
  noModel: 'Zuerst das Sparse Model berechnen.',
  source: 'Quelle',
  step: 'Kameras neu ausgleichen',
  freeParameters: 'Freie Parameter',
  hint: 'Hauptpunkt und Objektiv brauchen einen gut verteilten, stark überlappenden Block mit verschiedenen Blickwinkeln.',
  refine: {
    f: 'Brennweite',
    fcxcy: 'Brennweite + Hauptpunkt',
    full: 'Ganzes Objektiv (f, cx, cy, k1–k3, p1, p2)',
  },
  replaces:
    'Das Modell wird ersetzt: Seine Tiefenkarten und Georeferenzierung werden gelöscht, Dense Cloud, Mesh, DEM und ' +
    'Orthophoto bleiben, als veraltet markiert. <strong>Rekonstruktion ▸ Veraltete neu erstellen</strong> erstellt ' +
    'sie neu. Importierte Daten und Ihre bearbeiteten Kopien bleiben.',
  cancel: 'Abbrechen',
  run: 'Optimieren',
  needsModel: 'Braucht ein Sparse Model (Rekonstruktion ▸ Sparse Model)',
}
