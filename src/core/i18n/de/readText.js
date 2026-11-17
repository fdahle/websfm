// Deutsch: Text lesen (en/readText.js ist die Referenz).
export default {
  title: 'Text lesen',
  intro:
    'Findet und liest den Text auf jedem Foto mit PaddleOCR (13 MB, einmal heruntergeladen): Bildnummern, ' +
    'Datenleisten, Datenkarten. Brennweite und Datum, die auf den Fotos einer Kamera stehen, werden daraus ' +
    'gelesen; die Regel Text in <strong>Werkzeuge ▸ Bilder ▾ ▸ Auto-Maske…</strong> maskiert den Text.',
  read: '{n, plural, one {# Foto lesen} other {# Fotos lesen}}',
  readAgain: 'Alle neu lesen',
  cancel: 'Abbrechen',
  progress: 'Text lesen: {done, number} von {total, number} Fotos',
  status: '{read, number} von {n, number} Fotos gelesen · {lines, plural, one {# Textzeile} other {# Textzeilen}}',
  disabled: {
    busy: 'Warten, bis das Lesen fertig ist',
    allRead: 'Alle Fotos sind gelesen; Alle neu lesen liest sie erneut',
    noImages: 'Zuerst Bilder importieren',
  },
  camera: {
    focal: 'Gelesene Brennweite',
    date: 'Gelesenes Datum',
    none: 'nichts gelesen',
    onPhotos: '{value} ({photos, number} von {of, number} Fotos)',
    focalValue: '{mm, number, ::.000} mm',
    filled: 'führende Ziffern nicht auf den Fotos, für ein 6-Zoll-Objektiv ergänzt',
    current: 'Kamera: {mm, number, ::.000} mm',
    currentNone: 'Kamera: nicht gesetzt',
    use: '{mm, number, ::.000} mm übernehmen',
    same: 'Die Kamera hat bereits diese Brennweite',
  },
  photo: 'Foto',
  text: 'Gelesener Text',
  unread: 'nicht gelesen',
  noText: 'kein Text',
}
