// Deutsch: die Teile, die viele Dialoge teilen (en/dialog.js ist die Referenz).
// Menüpfade bleiben englisch, solange das Menüband nicht übersetzt ist.
export default {
  noSource: {
    cloud:
      'Noch keine dichte Punktwolke. Mit <strong>Reconstruct ▸ Dense Model</strong> erstellen oder eine importieren.',
    mesh: 'Noch kein Mesh. Mit <strong>Reconstruct ▸ Mesh</strong> erstellen oder eines importieren.',
  },

  rasterSize: {
    sizeBy: {
      label: 'Rastergröße nach',
      hint: 'Die Zellgröße setzen, oder die Pixel der längeren Seite, und die Zellgröße folgt aus der Ausdehnung.',
      gsd: 'Zellgröße (GSD)',
      px: 'Lange Seite (px)',
    },
    gsd: { label: 'GSD' },
    longSide: { label: 'Lange Seite', hint: 'Pixel auf der längeren Seite des Rasters. 0 = automatisch.' },
    estimating: 'Größe wird geschätzt…',
    unavailable: 'Rastergröße: {reason}.',
    readout:
      '{approx, select, yes {≈ } other {}}{width, number} × {height, number} px bei {gsd} {unit} · {bytes} unkomprimiert',
    cell: '{whole, select, yes {{g, number, ::precision-integer}} other {{g, number, ::@@@}}}',
    capped:
      'Ein Raster hat höchstens {max, number} px je Seite, daher nutzt der Lauf {gsd} statt {requested} {unit}. ' +
      'Für eine feinere Zelle den Bereich begrenzen (Tools ▸ Model ▸ Region).',
  },

  output: {
    title: 'Ausgabe',
    label: 'Haupt-{kind, select, dem {DEM} ortho {Orthofoto} mesh {Mesh} other {Punktwolke}} ersetzen',
    hint:
      'Aus: ältere {kind, select, dem {DEMs} ortho {Orthofotos} mesh {Meshes} other {dichte Punktwolken}} bleiben, ' +
      'und das neue Produkt wird zum Hauptprodukt (der Eingabe des nächsten Schritts). An: das neue tritt an die ' +
      'Stelle des Hauptprodukts und übernimmt dessen Namen.',
    effect: {
      first:
        '{kind, select, dem {Das erste DEM} ortho {Das erste Orthofoto} mesh {Das erste Mesh} ' +
        'other {Die erste dichte Punktwolke}}: „{name}“',
      replaces: 'Ersetzt „{main}“; darauf aufbauende Produkte bleiben, als veraltet markiert',
      kept:
        '„{main}“ wurde nicht von der Pipeline erstellt und bleibt daher: fügt „{name}“ als ' +
        '{kind, select, dem {Haupt-DEM} ortho {Haupt-Orthofoto} mesh {Haupt-Mesh} other {Haupt-Punktwolke}} hinzu',
      adds:
        'Fügt „{name}“ als ' +
        '{kind, select, dem {Haupt-DEM} ortho {Haupt-Orthofoto} mesh {Haupt-Mesh} other {Haupt-Punktwolke}} ' +
        'hinzu; „{main}“ bleibt',
    },
    short: { first: 'neu', replaces: 'ersetzt „{main}“', adds: 'fügt „{name}“ hinzu' },
  },

  presets: {
    button: 'Presets ▾',
    buttonLast: 'Presets · letzter Lauf ▾',
    buttonNamed: 'Presets · {name} ▾',
    titleLast: 'Mit den Einstellungen des letzten Laufs in diesem Projekt geöffnet',
    titleNamed: 'Preset {name}',
    title: 'Diese Einstellungen speichern oder gespeicherte zurückholen',
    delete: '{name} löschen',
    none: 'Noch keine gespeicherten Presets für diesen Dialog.',
    namePlaceholder: 'Name für diese Einstellungen',
    save: 'Speichern',
    typeName: 'Zuerst einen Namen eingeben',
    reset: 'Auf Standardwerte zurücksetzen',
  },

  frame: {
    label: 'Bezugsrahmen',
    hintScaled:
      'Lokal nutzt eine aus den Kameras geschätzte Ausrichtung und den derzeit besten Maßstabsnachweis; die ' +
      'Koordinaten sind metrisch, aber ohne CRS.',
    hint:
      'Lokal nutzt eine aus den Kameras geschätzte Hochachse (ohne Maßstab); das Projekt-CRS passt eine ' +
      'Ähnlichkeitstransformation an importierte Posen an, für reale ' +
      '{what, select, heights {Höhen} other {Koordinaten}} und GSD.',
    localScaled: 'Lokal (Meter, kein CRS)',
    local: 'Lokal (Modelleinheiten)',
    project: 'Projekt-CRS',
    blocked: {
      geographic: ' — geografisches CRS',
      evidence: ' — braucht ≥3 Kamerapositionen oder GCPs',
    },
    blockedTitle: {
      geographic: 'Das Projekt-CRS ist geografisch (Grad): ein projiziertes CRS wählen, um Meter zu erhalten',
      evidence: 'Die Georeferenzierung braucht mindestens drei Kamerapositionen oder GCPs',
      other: 'Das Modell ist noch nicht georeferenziert',
    },
  },

  crs: {
    inDegrees: '{crs} ist in Grad, daher kann das Modell nicht darauf eingepasst werden.',
    chooseProjected: 'Wählen Sie ein projiziertes CRS in Project Settings.',
    productsNeedProjected: 'DEMs und Orthofotos lassen sich nur in einem projizierten CRS georeferenzieren.',
    use: '{code} · {name} verwenden',
    from:
      'Aus {count, plural, one {# Kameraposition} other {# Kamerapositionen}} um {where}. Ein Wechsel des CRS ' +
      'projiziert vorhandene Positionen und GCPs um.',
  },

  importKind: {
    label: 'Importieren als',
    gcp: 'GCPs',
    pose: 'Kamerapositionen',
    sensor: 'Innere Orientierung',
    declared:
      'Import als <strong>{kind}</strong>. Nicht richtig? Als <first>{first}</first> oder <second>{second}</second> importieren.',
  },

  fileName: {
    label: 'Dateiname',
    savedAs: 'Gespeichert als {name}; die Endung wird ergänzt.',
    hint: 'Optional. Die Endung wird ergänzt; eine World-Datei oder .prj daneben erhält denselben Namen.',
  },
}
