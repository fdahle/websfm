// Deutsch: Matches (en/matchList.js ist die Referenz).
export default {
  title: 'Matches',
  ariaLabel: 'Match-Liste',
  count: '{n, plural, one {# Paar} other {# Paare}}',
  view: { list: 'Liste', graph: 'Graph' },
  empty: 'Noch keine Matches: zuerst das Feature-Matching ausführen.',
  filter: {
    imageTip: 'Nur Paare mit diesem Bild zeigen (auf beiden Seiten)',
    allImages: 'Alle Bilder',
    clear: 'Filter löschen',
    checkTip: 'Nur die Paare zeigen, die die Prüfung gegen das Sparse-Modell markiert',
    allPairs: 'Alle Paare',
    flagged: 'Von der Modellprüfung markiert',
    noRows: 'Keine Paare passen zum Filter.',
  },
  col: {
    imageA: 'Bild A',
    imageB: 'Bild B',
    matches: 'Matches',
    used: 'Genutzt',
    usedTip: 'Matches, die im Sparse-Modell zu Verknüpfungspunkten wurden',
    check: 'Modell',
    checkTip: 'Wie das Paar im Sparse-Modell sitzt, geprüft beim Lauf des Sparse-Modells',
  },
  excluded: 'Aus der Rekonstruktion herausgenommen',
  verdict: {
    holds: 'evtl. falsch',
    disagrees: 'widerspricht',
    overruled: 'überstimmt',
    agrees: 'passt',
  },
  verdictLong: {
    holds:
      'Vielleicht ein falsches Match: Es hält {photo} an seiner Stelle, obwohl {conflicts, number} von ' +
      '{pairs, number} Paaren dieses Fotos dem Modell widersprechen. Das Paar herausnehmen und das Sparse-Modell neu rechnen.',
    disagrees:
      'Widerspricht dem Modell: Eines seiner Fotos sitzt dort, wo die meisten seiner Matches widersprechen; ' +
      'das Paar kann also stimmen und das Foto falsch sitzen.',
    overruled:
      'Widerspricht dem Modell, das ihm nicht gefolgt ist: höchstwahrscheinlich ein falsches Match, für dieses Modell harmlos.',
    agrees: 'Passt zum Modell: {share, number, ::percent} seiner Matches passen zu den bestimmten Kameras.',
    agreesPoints:
      'Passt zum Modell: {n, plural, one {# Match ist ein Verknüpfungspunkt} other {# Matches sind Verknüpfungspunkte}}.',
  },
  exclude: {
    exclude: 'Aus der Rekonstruktion herausnehmen',
    excludeTip: 'Dieses Paar aus der Rekonstruktion herausnehmen (ein falsches Match)',
    restore: 'Herausgenommen: zum Wiederherstellen klicken',
    restoreTip: 'Dieses Paar wieder in die Rekonstruktion aufnehmen',
  },
  placeholder: 'Ein Paar wählen, um seine Matches zu sehen',
  resize: 'Ziehen, um die Breite zu ändern',
  graph: {
    force: 'Kräfte',
    geographic: 'Geografisch',
    modeTip: 'Kräfte: Feder-Layout · Geografisch: Kamerapositionen',
    reset: 'Layout zurücksetzen',
    resetTip: 'Das Layout zurücksetzen (verschobene Knoten verwerfen)',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    fit: 'Alles zeigen',
    empty: 'Keine verifizierten Paare für den Graphen.',
    hint:
      'Kante klicken: Vorschau · Doppelklick: herausnehmen oder wiederherstellen · Knoten ziehen: verschieben · ' +
      'Hintergrund ziehen: verschieben · Mausrad: zoomen',
    hover: '{a} ↔ {b} · {n, plural, one {# Match} other {# Matches}}',
    hoverExcluded: 'herausgenommen',
  },
}
