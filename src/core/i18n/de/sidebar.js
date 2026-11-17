// Deutsch: die Abschnitte der Seitenleiste (en/sidebar.js ist die Referenz).
export default {
  images: {
    groupBy: 'Gruppieren nach',
    byGroup: 'Gruppen',
    bySensor: 'Sensoren',
    byGroupTitle: 'Die Bilder unter den Bildgruppen auflisten, die Sie angelegt haben',
    bySensorTitle:
      'Die Bilder unter ihren Sensoren auflisten. Bilder auf einen Sensor ziehen, um sie dorthin zu verschieben',
    noSensor: 'Kein Sensor',
    noSensorTitle: 'Bilder, die noch keinem Sensor zugeordnet sind',
    sensorHeader:
      '{name} — {n, plural, one {# Bild} other {# Bilder}}. Bilder hier ablegen, um sie diesem Sensor zuzuordnen',
    setSensor: 'Sensor zuordnen',
    newSensor: '{n, plural, one {Neuer Sensor für dieses Bild} other {Neuer Sensor aus Auswahl}}',
    newSensorTitle: 'Diesen Bildern einen eigenen Sensor geben, eine Kopie des bisherigen',
    sensorInfo: 'Sensorinformationen anzeigen',
  },
  sensors: {
    title: 'Sensoren',
    collapse: 'Zuklappen',
    expand: 'Aufklappen',
    incomplete:
      'Keine verwendbare Kalibrierung — die Intrinsik fällt auf ein geschätztes Sichtfeld zurück, das SfM und Tiefenkarten verzerrt. Eine Brennweite in der Sensortabelle setzen.',
    split:
      'Enthält vielleicht Bilder von {n} Kameras ({why}). Rechtsklick auf den Sensor und Kameragruppe aufteilen… wählen',
    splitFormats: '{n} Scanformate',
    splitMisfit: '{roll} passt schlecht zum Rahmenmarken-Layout',
    count: '{n, plural, one {# Bild} other {# Bilder}}: klicken, um sie unter Bilder auszuwählen',
    countNone: 'Kein Bild verwendet diesen Sensor',
    source: 'Quelle',
    sourceExif: 'EXIF',
    sourceImported: 'importiert',
    dimensions: 'Abmessungen',
    dimensionsValue: '{w, number} × {h, number}',
    focal: 'Brennweite',
    focalValue: '{v, number, ::@##} {unit}',
    principal: 'Hauptpunkt',
    principalValue: '{x, number, ::.#}, {y, number, ::.#}',
    lens: 'Objektiv',
    none: '—',
    empty: 'Keine Sensoren — Bilder hinzufügen oder eine Kalibrierung importieren',
    menu: {
      info: 'Informationen anzeigen',
      selectImages: 'Bilder auswählen',
      split: 'Kameragruppe aufteilen…',
      mergeInto: 'Zusammenführen mit',
      remove: 'Sensor entfernen',
    },
  },
}
