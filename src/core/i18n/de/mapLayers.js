// Deutsch: Ansicht ▸ Karte ▸ Ebenen (en/mapLayers.js ist die Referenz).
export default {
  title: 'Ebenen',
  close: 'Ebenen schließen',
  empty:
    'Keine Ebenen auf der Karte. Haken Sie in der Seitenleiste ein DEM, ein Orthofoto, ein Referenzraster, ' +
    'Höhenlinien oder Polygone an, um sie hier aufzunehmen.',
  list: 'Kartenebenen, oberste zuerst',
  kind: {
    referenceDem: 'Referenz-DEM',
    referenceOrtho: 'Referenz-Orthofoto',
    dem: 'DEM',
    ortho: 'Orthofoto',
    contours: 'Höhenlinien',
    polygons: 'Polygone',
    photos: 'Quellbilder auf dem Gelände',
  },
  photos: 'Fotos',
  unplaced: 'Kein Koordinatensystem oder keine Vorschau: die Karte kann sie nicht platzieren',
  row: '{kind} · klicken für ihre Einstellungen',
  drag: 'Ziehen zum Umordnen: oben in der Liste wird oben gezeichnet',
  show: { label: '{name} auf der Karte zeigen', title: 'Auf der Karte gezeigt; abgehakt bleibt sie in der Liste' },
  up: { label: '{name} nach oben', title: 'Nach oben: über die Ebene darüber zeichnen' },
  down: { label: '{name} nach unten', title: 'Nach unten: unter die Ebene darunter zeichnen' },
  remove: {
    label: '{name} von der Karte nehmen',
    title: 'Von der Karte nehmen (sie bleibt in der Seitenleiste)',
  },
  settingsOf: 'Einstellungen von {name}',
  opacity: { label: 'Deckkraft von {name}', title: 'Deckkraft auf der Karte', value: '{v, number, percent}' },
  zoomTo: {
    label: 'Hinzoomen',
    title: 'Die Karte auf diese Ebene einpassen',
    hidden: 'Zuerst anhaken, um sie zu zeigen',
  },
  photosShow: {
    label: 'Zeigen',
    all: 'Jedes Bild (Vorschaubilder)',
    selected: 'Das ausgewählte Bild',
    hint: 'Klicken Sie eine Kamera oder einen Footprint (oder ein Bild in der Seitenleiste), um sein Foto zu zeigen.',
  },
  above: 'Footprints, GCPs und Kameras werden immer über den Ebenen gezeichnet.',
}
