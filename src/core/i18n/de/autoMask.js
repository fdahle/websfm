// Deutsch: Auto-Maske (en/autoMask.js ist die Referenz).
export default {
  title: 'Auto-Maske',
  rule: {
    label: 'Regel',
    border: 'Rand',
    frame: 'Bildrahmen',
    text: 'Text',
  },
  border: {
    title: 'Rand maskieren',
    hint: '(äußere Pixel ausschließen)',
    side: { top: 'oben', right: 'rechts', bottom: 'unten', left: 'links' },
    linked: 'Alle Seiten gleich',
  },
  frame: {
    title: 'Filmrahmen maskieren',
    hint: '(auf jedem Scan gesucht)',
    inset: 'Einzug',
    insetUnit: '% der langen Seite',
    about:
      'Findet, wo das Foto auf jedem Scan beginnt, hinter dem dunklen Filmrand und einem hellen Scannerbett, ' +
      'und maskiert den Rahmen darum. Scans gleicher Größe werden miteinander verglichen: eine Seite, die weit ' +
      'von den anderen abweicht, übernimmt deren Wert.',
    progress: 'Rahmen suchen: {done, number} von {total, number} Fotos',
    groupFound: 'Rahmen auf {found, number} von {n, number} gefunden',
    done:
      '{masked, plural, one {# Foto} other {# Fotos}} maskiert' +
      '{replaced, plural, =0 {} one {, # mit einer Seite von den anderen} other {, # mit einer Seite von den anderen}}' +
      '{none, plural, =0 {} other {, # ohne Rahmen (siehe Protokoll)}}' +
      '{failed, plural, =0 {} other {, # fehlgeschlagen (siehe Protokoll)}}',
  },
  text: {
    title: 'Text maskieren',
    hint: '(Bildnummern, Datenleisten, Beschriftungen)',
    pad: 'Rand um den Text',
    recurring: 'Text an derselben Stelle auf den Fotos einer Kamera',
    about:
      'Findet und liest den Text auf jedem Foto mit PaddleOCR (13 MB, einmal heruntergeladen). ' +
      'Das Gelesene bleibt gespeichert, ein späterer Lauf mit anderen Einstellungen ist schnell.',
    reading: 'Text lesen: {done, number} von {total, number} Fotos',
    masking: 'Masken schreiben: {done, number} von {total, number} Fotos',
    groupRead: '{read, number} von {n, number} gelesen · {lines, plural, one {# Textzeile} other {# Textzeilen}}',
    groupUnread: 'noch nicht gelesen',
    done:
      '{masked, plural, one {# Foto} other {# Fotos}} maskiert' +
      '{cleared, plural, =0 {} one {, # Maske entfernt (kein Text)} other {, # Masken entfernt (kein Text)}}' +
      '{skipped, plural, =0 {} other {, # übersprungen (siehe Protokoll)}}' +
      '{failed, plural, =0 {} other {, # nicht gelesen (siehe Protokoll)}}',
  },
  existing: {
    label: 'Wenn eine Maske existiert',
    merge: 'Zusammenführen',
    replace: 'Ersetzen',
  },
  px: 'px',
  applyAll: 'Auf alle Gruppen anwenden',
  applyGroup: 'Auf Gruppe anwenden',
  cancel: 'Abbrechen',
  empty: 'Keine Bilder.',
  group: {
    size: '{w} × {h}',
    unknown: 'Unbekannte Größe',
    count: '{n, plural, one {# Bild} other {# Bilder}}',
  },
  hint:
    '{masked, number} von {n, number} maskiert. Rote Bereiche werden von der Merkmalserkennung und der dichten ' +
    'Punktwolke ausgeschlossen, beim nächsten Erkennungs- oder Dense-Lauf.',
  disabled: {
    busy: 'Warten, bis die Masken geschrieben sind',
    noSizes: 'Die Bildgrößen sind noch nicht bekannt: warten, bis die Bilder geladen sind',
    unknownSize: 'Unbekannte Größe: ein Bild öffnen und die Maske von Hand zeichnen',
  },
  failed: {
    title: 'Auto-Maske fehlgeschlagen',
    detail: '{done, number} von {total, number} Bildern maskiert, bevor {name} fehlschlug: {why}',
  },
}
