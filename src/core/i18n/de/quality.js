// Der Qualitätsbericht (components/modals/eval/): die Beschriftungen seiner Abschnitte.
export default {
  decimal1: '{v, number, ::.0}',
  decimal2: '{v, number, ::.00}',
  threshold: {
    above: 'Warnung > {warn, number} {unit}',
    aboveAbs: 'Warnung > ±{warn, number} {unit}',
    below: 'Warnung < {warn, number} {unit}',
  },
  sparse: {
    noModel: 'Kein Sparse-Modell.',
    tile: {
      registered: 'Registriert',
      registeredValue: '{n, number} / {total, number}',
      photos: 'Fotos',
      tiePoints: 'Verknüpfungspunkte',
      count: '{n, number}',
      reprojMedian: 'Reprojektionsfehler Median',
      reprojP95: 'Reprojektionsfehler P95',
      reprojMax: 'Reprojektionsfehler max.',
      observations: 'Beobachtungen',
    },
    summary: {
      title: 'Zusammenfassung des Laufs',
      note: '(aus der letzten Rekonstruktion)',
      tracks3: 'Tracks mit ≥3 Ansichten',
      p95Before: 'P95 vor der Bündelausgleichung',
      medianAfter: 'Median nach der Bündelausgleichung',
      date: 'Datum des Laufs',
    },
    added: {
      title:
        'Fotos hinzugefügt {when}: {added, number} hinzugefügt{notPlaced, plural, =0 {} other {, # nicht platziert}} ({how})',
      refined: 'danach jede Kamera verfeinert',
      fixed: 'die Kameras des Modells fest',
      notPlaced: 'nicht platziert',
      retry: 'Erneut versuchen…',
      retryNote:
        'Öffnet Sparse-Modell, um {n, plural, one {das # Foto} other {die # Fotos}} mit lockereren ' +
        'Registrierungsschwellen erneut hinzuzufügen ({matches, number} Korrespondenzen, {px, number} px).',
    },
    tracks: {
      title: 'Verteilung der Track-Längen',
      foot: 'Fotos je Verknüpfungspunkt (Verknüpfungspunkte in 2 oder mehr Fotos)',
    },
    table: {
      photo: 'Foto',
      keypoints: 'Keypoints',
      pairs: 'Paare',
      observations: 'Beobachtungen',
      rms: 'RMS',
      median: 'Median',
      max: 'Max',
      empty: 'Keine registrierten Fotos.',
      note: 'Ein Klick auf eine Zeile öffnet das Foto mit seinen Reprojektionsfehlern. Nach RMS sortiert, die schlechtesten zuerst.',
    },
    notRegistered: 'Nicht registriert ({n, number})',
    reason: {
      noFeatures: 'keine Features',
      noPairs: 'keine akzeptierten Paare',
      disconnected: 'nicht verbunden (Komponente {n, number})',
    },
  },
}
