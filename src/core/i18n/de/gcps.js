// Deutsch: GCPs und Marker in den Ansichten (en/gcps.js ist die Referenz).
export default {
  toolbox: {
    title: 'Punkte',
    close: 'Punktbearbeitung beenden',
    markImage: 'Auf das Foto klicken, um „{name}“ zu markieren',
    placeMap: 'Auf die Karte klicken, um „{name}“ zu setzen',
    addImage: 'Auf das Foto klicken, um einen neuen {role, select, marker {Marker} other {Passpunkt}} anzulegen',
    addMap: 'Auf die Karte klicken, um einen neuen Passpunkt anzulegen',
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
    placedMap: 'Auf der Karte gesetzt',
    unplacedMap: 'Noch keine Position im Gelände',
    disabled: '„{name}“ ist deaktiviert und wird nicht verwendet',
    delete: 'Diesen Punkt löschen',
    empty: 'Noch keine Punkte. Zum Anlegen klicken.',
    markersHidden:
      '{n, plural, one {# Marker ist} other {# Marker sind}} nicht aufgeführt: Ein Marker hat keine Position im ' +
      'Gelände. {n, plural, one {Ihn} other {Sie}} auf einem Foto markieren.',
  },
}
