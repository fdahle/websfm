// Deutsch: Punktwolke filtern (en/filterCloud.js ist die Referenz).
export default {
  title: {
    filter: 'Punktwolke filtern',
    sor: 'Outlier entfernen',
    voxel: 'Punktwolke ausdünnen',
  },
  noCloud:
    'Keine dichte Punktwolke vorhanden. Erstellen Sie zuerst eine (<strong>Rekonstruktion ▸ Dense-Modell</strong>) ' +
    'oder importieren Sie eine. Um das dünne Modell zu bereinigen, nutzen Sie ' +
    '<strong>Werkzeuge ▸ Modell ▾ ▸ Schrittweise Auswahl…</strong>.',
  sourceHint: 'Der Filter erzeugt eine neue Punktwolke; diese bleibt unverändert.',
  run: 'Filtern',
  resultName: '{name} (gefiltert)',
  disabled: {
    noCloud: 'Noch keine dichte Punktwolke: mit Rekonstruktion ▸ Dense-Modell erstellen oder eine importieren',
    noFilter: 'Mindestens einen Filter einschalten',
  },
  preset: {
    light: { label: 'Leicht', blurb: 'Nur Outlier-Entfernung · entfernt offensichtliche Fehlpunkte' },
    medium: { label: 'Ausgewogen', blurb: 'Outlier-Entfernung bei 1,5σ · Standard' },
    strong: { label: 'Stark', blurb: 'Isolierte Cluster + 1,0σ · kann feine Details angreifen' },
  },
  step: {
    range: 'Höhen-/Helligkeitsbereich',
    voxel: 'Voxel-Ausdünnung',
    isolated: 'Isolierte Cluster',
    sor: 'Statistische Outlier',
  },
  field: {
    zRange: { label: 'Höhe (Z)', hint: 'Leer lassen für unbegrenzt.' },
    lumaRange: { label: 'Helligkeit', hint: 'Rec.-709-Luma. Bei einer Punktwolke ohne Farbe ignoriert.' },
    voxelCell: {
      label: 'Zellgröße',
      hintMerge: '0 = automatisch (die Zellgröße der dichten Punktwolke, {cell, number, ::@##})',
      hintAuto: '0 = automatisch (etwa ein Punktabstand)',
    },
    isolatedCell: {
      label: 'Zellgröße',
      hint: 'Zelle des Belegungsrasters. 0 = automatisch (etwa 4× der Punktabstand).',
    },
    isolatedMinNeighbors: {
      label: 'Min. belegte Nachbarn',
      hint: 'So viele ihrer 26 Nachbarn muss eine schwach belegte Zelle belegt haben, um zu bleiben.',
    },
    isolatedMaxSupport: {
      label: 'Max. geprüfte Belegung',
      unit: 'Punkte',
      hint: 'Zellen mit mehr Punkten werden nie geprüft – sie sind echte Oberfläche.',
    },
    sorK: { label: 'Nachbarn', hint: 'Über wie viele nächste Nachbarn der mittlere Abstand je Punkt gemittelt wird.' },
    sorStdRatio: {
      label: 'Std.-Abw.-Faktor',
      hint: 'Entfernt Punkte über Mittel + Faktor × σ. Kleiner entfernt mehr.',
    },
  },
  span: {
    between: '{lo, number, ::.##########} – {hi, number, ::.##########}',
    atLeast: 'mindestens {lo, number, ::.##########}',
    atMost: 'höchstens {hi, number, ::.##########}',
  },
  effect: {
    range: {
      off: 'Aus: keine Höhen- oder Helligkeitsgrenze.',
      none: 'Noch keine Grenze eingegeben: jeder Punkt bleibt. Setzen Sie eine Höhen- oder Helligkeitsgrenze.',
      kept: 'Punkte mit {limits} bleiben, die übrigen werden entfernt.',
      elevation: 'Höhe {span}',
      brightness: 'Helligkeit {span}',
    },
    voxel: {
      off: 'Aus: die Punktdichte bleibt unverändert.',
      cell: 'Die Punktwolke wird auf einen gemittelten Punkt je Zelle von {cell} ausgedünnt.',
      mergeCell:
        'Die Punktwolke wird auf einen gemittelten Punkt je Zelle von {cell} ausgedünnt, der Zellgröße der dichten Punktwolke.',
      spacing: 'Die Punktwolke wird auf einen gemittelten Punkt je Zelle von etwa einem Punktabstand ausgedünnt.',
    },
    isolated: {
      off: 'Aus: kleine abgelöste Cluster bleiben.',
      on:
        'Auf einem Raster von {cell} werden Zellen mit höchstens {maxSupport, plural, one {# Punkt} other {# Punkten}} ' +
        'und weniger als {minNeighbors, number} belegten Nachbarn entfernt.',
      autoCell: 'etwa 4 Punktabständen',
    },
    sor: {
      off: 'Aus: kein statistischer Outlier-Test.',
      on:
        'Ein Punkt wird entfernt, wenn sein mittlerer Abstand zu seinen {k, number} nächsten Nachbarn mehr als ' +
        '{ratio, number} σ über dem Mittel der Punktwolke liegt.',
    },
  },
  short: {
    range: {
      none: 'noch keine Grenze',
      z: 'z {span}',
      zAndBrightness: 'z {span} · Helligkeit',
      brightness: 'Helligkeit',
    },
    voxel: { cell: 'Zellen von {cell}', spacing: 'ein Punktabstand' },
    isolated: '≤ {maxSupport, number} Pkt., < {minNeighbors, number} Nachbarn',
    sor: '{k, number} Nachbarn · {ratio, number} σ',
  },
}
