// Deutsch: GCPs und Marker in den Ansichten (en/gcps.js ist die Referenz).
export default {
  toolbox: {
    title: 'Punkte',
    close: 'Punktbearbeitung beenden',
    markImage: 'Auf das Foto klicken, um „{name}“ zu markieren',
    placeGround: 'Auf {where, select, raster {das Raster} other {die Karte}} klicken, um „{name}“ zu setzen',
    addImage: 'Auf das Foto klicken, um einen neuen {role, select, marker {Marker} other {Passpunkt}} anzulegen',
    addGround: 'Auf {where, select, raster {das Raster} other {die Karte}} klicken, um einen neuen Passpunkt anzulegen',
    newControl: '＋ Neuer Passpunkt',
    newControlTip: 'Ein vermessener Punkt, der die Georeferenzierung bestimmt',
    newMarker: '＋ Neuer Marker',
    newMarkerTip: 'Ein Endpunkt eines Maßstabs: Markierungen im Bild, keine vermessene Position',
    group: {
      control: 'Passpunkte ({n, number})',
      check: 'Checkpoints ({n, number})',
      marker: 'Marker ({n, number})',
    },
    markedImage: 'Auf diesem Foto markiert',
    unmarkedImage: 'Auf diesem Foto nicht markiert',
    placed: 'Hat eine Position im Gelände',
    unplaced: 'Noch keine Position im Gelände',
    disabled: '„{name}“ ist deaktiviert und wird nicht verwendet',
    delete: 'Diesen Punkt löschen',
    empty: 'Noch keine Punkte. Zum Anlegen klicken.',
    markersHidden:
      '{n, plural, one {# Marker ist} other {# Marker sind}} nicht aufgeführt: Ein Marker hat keine Position im ' +
      'Gelände. {n, plural, one {Ihn} other {Sie}} auf einem Foto markieren.',
  },
  table: {
    estimateTip:
      'Grau: wo das georeferenzierte Modell diesen Punkt sieht, als Hilfe beim Suchen. Den vermessenen Wert ' +
      'eintragen; bis dahin wird der Punkt nicht als Passpunkt verwendet.',
  },
  view: {
    fallbackName: 'GCP',
    coords: 'X {x} · Y {y}',
    coordsZ: 'X {x} · Y {y} · Z {z}',
    noCoords: 'keine Koordinaten',
    estimate: 'laut Modell bei ≈ X {x} · Y {y} · Z {z}',
    photos: '{n, plural, one {# Foto} other {# Fotos}}',
    notLoaded: '+{n, number} nicht geladen',
    notLoadedTip:
      '{n, plural, one {# Markierung liegt} other {# Markierungen liegen}} auf Fotos, die (noch) nicht im Projekt sind',
    acceptAll: '{n, plural, one {# Erkennung} other {# Erkennungen}} übernehmen',
    acceptAllTip:
      'Alle Markierungen von Ziele erkennen hier als eigene übernehmen; die falschen vorher entfernen ({key})',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    open: '{name} öffnen',
    detected: 'erkannt {score, number, ::.00}',
    detectedTip: 'Von Ziele erkennen gesetzt (Score); verschieben, wenn sie daneben liegt, dann zählt sie als eigene',
    reproj: '{px, number, ::.0} px',
    reprojTip: 'Reprojektionsfehler',
    accept: 'Die erkannte Markierung in {name} übernehmen ({key} für die hervorgehobene)',
    remove: 'Die Markierung in {name} entfernen',
    removeKey: 'Die Markierung in {name} entfernen ({key} für die hervorgehobene)',
    dragTip: 'Ziehen, um die Markierung zu verschieben',
    empty:
      'Dieser GCP ist noch auf keinem Foto markiert. Auf einem Foto markieren (GCPs bearbeiten oder Rechtsklick auf ein Foto).',
    likely: 'Wahrscheinlich auf {n, plural, one {# weiteren Foto} other {# weiteren Fotos}}',
    fromMarks: 'aus {n, plural, one {seiner # Markierung} other {seinen # Markierungen}}',
    fromMarksRejected:
      'aus {used, number} seiner {n, number} Markierungen; {rejected, number} passen nicht zu den übrigen',
    fromCoordinates: 'aus seinen Koordinaten über die Georeferenzierung',
    likelyHint: 'Dorthin klicken, wo der Punkt ist, oder das Fadenkreuz darauf ziehen, um ihn dort zu markieren.',
    likelyNone:
      '{why, select, oneMark {Auf einem weiteren Foto markieren, dann erscheinen hier die Fotos, auf denen er wahrscheinlich ist.} noModel {Sparse Model ausführen, dann erscheinen hier die Fotos, auf denen er wahrscheinlich ist.} other {}}',
    likelyTip: 'Wo das Modell den Punkt in {name} sieht. Dorthin klicken, wo er ist, oder das Fadenkreuz ziehen',
    place: 'Hier markieren: am Fadenkreuz ({key} für das hervorgehobene)',
    dismiss: 'Nicht auf diesem Foto: ausblenden ({key} für das hervorgehobene)',
    showMore: '{n, number} weitere zeigen',
  },
}
