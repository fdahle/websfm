// Deutsch: Auto-Maske (en/autoMask.js ist die Referenz).
export default {
  title: 'Auto-Maske',
  intro:
    'Maskiert die Ränder der Fotos, den Text darauf oder beides. Maskierte Pixel bleiben ab dem nächsten Lauf ' +
    'aus der Merkmalserkennung und den Tiefenkarten heraus.',
  photos: {
    label: 'Fotos',
    all: 'Alle Fotos ({n, number})',
    sensor: '{name} ({n, number})',
  },
  step: {
    edges: 'Ränder',
    text: 'Text',
    existing: 'Vorhandene Masken',
  },
  edges: {
    method: 'Methode',
    off: 'Aus',
    strip: 'Fester Streifen',
    frame: 'Filmrahmen',
    side: { top: 'Oben', right: 'Rechts', bottom: 'Unten', left: 'Links' },
    linked: 'Alle Seiten gleich',
    inset: 'Einzug',
    insetUnit: '% der langen Seite',
  },
  text: {
    enabled: 'Text maskieren',
    pad: 'Rand um den Text',
    recurring: 'Text an derselben Stelle auf den Fotos eines Sensors',
  },
  existing: {
    label: 'Wenn eine Maske existiert',
    merge: 'Zusammenführen',
    replace: 'Ersetzen',
  },
  px: 'px',
  run: '{n, plural, one {# Foto} other {# Fotos}} maskieren',
  disabled: {
    nothing: 'Ränder oder Text einschalten: noch gibt es nichts zu maskieren',
    noSizes: 'Die Bildgrößen sind noch nicht bekannt: warten, bis die Bilder geladen sind',
  },
  effect: {
    edges: {
      off: 'Aus: kein Rand wird maskiert.',
      stripEven: 'Ein Streifen von {px, number} px an jedem Rand von {n, plural, one {# Foto} other {# Fotos}}.',
      strip:
        'Ein Streifen an den Rändern von {n, plural, one {# Foto} other {# Fotos}}: oben {top, number}, ' +
        'rechts {right, number}, unten {bottom, number}, links {left, number} px.',
      stripZero: 'Alle Seiten stehen auf 0 px: kein Rand wird maskiert.',
      frame:
        'Findet auf jedem von {n, plural, one {# Scan} other {# Scans}}, wo das Foto beginnt, hinter dem dunklen ' +
        'Filmrand und einem hellen Scannerbett, und maskiert darum herum, {inset, number} % der langen Seite nach ' +
        'innen. Scans gleicher Größe werden miteinander verglichen: eine Seite, die weit von den anderen ' +
        'abweicht, übernimmt deren Wert.',
    },
    text: {
      off: 'Aus: der Text bleibt unmaskiert.',
      on:
        'Liest den Text auf {n, plural, one {# Foto} other {# Fotos}} ({unread, plural, =0 {alle schon gelesen} ' +
        'other {# zu lesen mit PaddleOCR, 13 MB, einmal heruntergeladen}}) und maskiert jede klar gelesene ' +
        'Zeile, {pad, number} px darum herum.',
      onRecurring:
        'Liest den Text auf {n, plural, one {# Foto} other {# Fotos}} ({unread, plural, =0 {alle schon gelesen} ' +
        'other {# zu lesen mit PaddleOCR, 13 MB, einmal heruntergeladen}}) und maskiert jede klar gelesene ' +
        'Zeile, {pad, number} px darum herum, und den Text, den ein Sensor an derselben Stelle auf alle seine ' +
        'Fotos druckt.',
    },
    existing: {
      none: 'Keines dieser Fotos hat schon eine Maske.',
      merge:
        'Zusammenführen: die neue Maske kommt zu den Masken der {m, plural, one {# Foto} other {# Fotos}} hinzu, ' +
        'die eine haben.',
      replace:
        'Ersetzen: die neue Maske tritt an die Stelle der Masken der {m, plural, one {# Foto} other {# Fotos}}, ' +
        'die eine haben.',
    },
    unsized:
      '{line} {k, plural, one {# Foto unbekannter Größe wird übersprungen.} other {# Fotos unbekannter Größe werden übersprungen.}}',
  },
  short: {
    edges: {
      stripEven: '{px, number} px Streifen',
      strip: 'Streifen {top, number}/{right, number}/{bottom, number}/{left, number} px',
      frame: 'Filmrahmen · {inset, number} %',
    },
    text: {
      on: '{pad, number} px',
      onRecurring: '{pad, number} px · wiederkehrend',
    },
    existing: {
      merge: 'zusammenführen',
      replace: 'ersetzen',
    },
  },
  progress: {
    strip: 'Randstreifen maskieren',
    frame: 'Filmrahmen suchen',
    read: 'Text lesen',
    text: 'Text maskieren',
  },
  done: {
    strip: 'Randstreifen auf {masked, plural, one {# Foto} other {# Fotos}}',
    frame:
      'Filmrahmen auf {masked, plural, one {# Foto} other {# Fotos}}' +
      '{replaced, plural, =0 {} other {, # mit einer Seite von den anderen}}' +
      '{none, plural, =0 {} other {, # ohne Rahmen (siehe Protokoll)}}' +
      '{failed, plural, =0 {} other {, # fehlgeschlagen (siehe Protokoll)}}',
    text:
      'Text auf {masked, plural, one {# Foto} other {# Fotos}}' +
      '{cleared, plural, =0 {} one {, # Maske entfernt (kein Text)} other {, # Masken entfernt (kein Text)}}' +
      '{skipped, plural, =0 {} other {, # übersprungen (siehe Protokoll)}}' +
      '{failed, plural, =0 {} other {, # nicht gelesen (siehe Protokoll)}}',
    unsized: '{n, plural, one {# Foto} other {# Fotos}} unbekannter Größe übersprungen',
  },
  failed: 'Auto-Maske fehlgeschlagen',
}
