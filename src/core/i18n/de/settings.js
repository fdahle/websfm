// Deutsch: Einstellungen (SettingsModal.vue); en/settings.js ist die Referenz.
export default {
  title: 'Einstellungen',
  tab: {
    general: 'Allgemein',
    view: 'Karte & 3D',
    compute: 'Rechnen',
    storage: 'Speicher',
  },
  group: {
    appearance: 'Darstellung',
    startup: 'Beim Start',
    help: 'Hilfe',
    editing: 'Bearbeiten',
    notices: 'Hinweise',
    map: 'Karte',
    view3d: '3D-Ansicht',
    resources: 'Ressourcen',
    run: 'Während eines Laufs',
    data: 'Daten in diesem Browser',
    settings: 'Einstellungen',
    advanced: 'Erweitert',
  },
  advancedHidden:
    '{n, plural, one {# erweiterte Einstellung ausgeblendet} other {# erweiterte Einstellungen ausgeblendet}}: Schalten Sie unten „Erweiterte Einstellungen anzeigen“ ein.',

  theme: {
    label: 'Design',
    system: 'System',
    light: 'Hell',
    dark: 'Dunkel',
    followsSystem: 'Folgt dem Betriebssystem, derzeit {mode, select, light {hell} other {dunkel}}.',
    fixed: 'Gilt in der ganzen App.',
  },
  motion: {
    label: 'Bewegung',
    desc: 'Dem Betriebssystem folgen oder Animationen der Oberfläche auf ein Minimum beschränken.',
    system: 'System folgen',
    reduce: 'Bewegung reduzieren',
  },
  language: {
    label: 'Sprache',
    full: 'Übersetzt',
    partial: 'Teilweise übersetzt',
    planned: 'Noch nicht übersetzt',
    plannedReason: 'Noch nicht übersetzt: für eine spätere Version geplant',
    descFull: 'Die Sprache von Menüs, Dialogen und Hilfe. Protokoll und Konsolenbefehle bleiben englisch.',
    descPartial:
      'Teilweise übersetzt: Was noch nicht übersetzt ist, erscheint englisch. Protokoll und Konsolenbefehle bleiben englisch.',
  },
  openLast: {
    label: 'Beim Start das letzte Projekt öffnen',
    desc: 'Beim Start von WebSfM das zuletzt bearbeitete Projekt mit seinen offenen Tabs öffnen statt der Projektliste. Ein Projekt, das beim letzten Mal nicht fertig geöffnet wurde, wird nicht erneut geöffnet.',
  },
  glossary: {
    label: 'Glossarbegriffe',
    desc: 'Erklärte Wörter unterstreichen und Einstellungen mit Rat ein ? anhängen; beim Darüberfahren erscheinen die Erklärung und ein Link zum ganzen Eintrag.',
  },
  confirmMark: {
    label: 'Vor dem Entfernen einer Markierung fragen',
    desc: 'Nachfragen, bevor eine einzelne Bildmarkierung eines GCPs oder Markers gelöscht wird.',
  },
  bugButton: {
    label: 'Schaltfläche „Fehler melden“',
    desc: 'Die runde Schaltfläche unten rechts zeigen, die ein neues GitHub-Issue öffnet. Auch Weiteres ▸ Über verlinkt dorthin.',
  },
  browserWarning: {
    label: 'Bei nicht unterstütztem Browser warnen',
    desc: 'Erinnern, wenn die Grenzen dieses Browsers die Verarbeitung oder den Dateizugriff beeinträchtigen können.',
  },
  mobileWarning: {
    label: 'Auf Mobilgeräten warnen',
    desc: 'Den Hinweis zeigen, dass WebSfM für einen Desktop-Rechner gemacht ist und das Layout nicht auf ein Telefon passt.',
  },

  basemap: {
    label: 'Kartenhintergrund',
    desc: 'Automatisch verwendet OpenStreetMap und für ein polares Koordinatensystem die passende NASA-Ebene. Satellit und Gelände gibt es für polare Systeme nicht.',
  },
  satellite: {
    label: 'Quelle der Satellitenbilder',
    desc:
      'Standardmäßig zeigt Satellit Esri World Imagery, unter den <terms>Nutzungsbedingungen von Esri</terms>: Für ' +
      'kommerzielle Nutzung kann ein ArcGIS-Konto nötig sein. Für einen Anbieter, für den Sie eine Lizenz haben, ' +
      "geben Sie seine XYZ-Kachel-URL mit <code>'{z}'</code>, <code>'{x}'</code> und <code>'{y}'</code> ein (und " +
      'Ihren API-Schlüssel, falls nötig). Sie bleibt nur in diesem Browser.',
    urlPlaceholder: 'Esri World Imagery (Standard)',
    urlLabel: 'URL der Satellitenkacheln',
    attributionPlaceholder: 'Quellenangabe, z. B. © Anbieter',
    attributionLabel: 'Quellenangabe der Satellitenbilder',
    needsUrl: 'Geben Sie zuerst eine Kachel-URL ein',
    apply: 'Übernehmen',
    noChanges: 'Keine Änderungen zu übernehmen',
    useEsri: 'Esri verwenden',
    alreadyEsri: 'Esri ist bereits gewählt',
    errorHttps: 'Die URL muss mit https:// beginnen',
    errorPlaceholders: "Die URL braucht die Platzhalter '{z}', '{x}' und '{y}'",
  },
  background: {
    label: '3D-Hintergrund',
    desc: 'Ein schlichter Hintergrund für die 3D-Ansicht, unabhängig vom Design der App.',
    theme: 'Design folgen',
    dark: 'Dunkelgrau',
    light: 'Hellgrau',
    black: 'Schwarz',
  },
  gridZ: {
    label: 'Höhe des 3D-Bodengitters',
    desc: 'Das Referenzgitter unten, in der Mitte oder oben an die geladene Punktwolke legen.',
    min: 'Unten',
    avg: 'Mitte',
    max: 'Oben',
  },
  nearClip: {
    label: 'Nahe Schnittebene (3D)',
    desc: 'Wie nah an der Kamera Punkte noch gezeichnet werden, in Szeneneinheiten. 0 passt sie beim Zoomen an; setzen Sie einen kleinen Abstand, wenn nahe Punkte verschwinden.',
  },
  pointBudget: {
    label: '3D-<glossary>Punktbudget</glossary> (Millionen Punkte)',
    desc: 'Punktwolken ab 4 Millionen Punkten werden mit Detailstufen gezeichnet: höchstens so viele Punkte auf einmal, die meisten Details dort, wo Sie hinsehen. Senken Sie den Wert, wenn das Drehen ruckelt.',
  },

  memory: {
    label: 'Speichergrenze',
    desc: 'Der Speicher, mit dem die aufwendigen Schritte (Detektion, Tiefenkarten, dichte Punktwolke, DEM, Orthophoto) planen: Sie teilen ihre Arbeit so auf, dass sie darunter bleiben, und starten nicht, wenn das nicht geht. Erhöhen Sie sie, wenn der Rechner mehr freien Speicher hat und ein Schritt abgelehnt wird; senken Sie sie, wenn der Tab abstürzt.',
    auto: 'Automatisch gesetzt: {source, select, device {der Rechner meldet {gb, number} GB Arbeitsspeicher} heap {nach der Speichergrenze des Browsers} other {der Browser meldet keinen Speicher, daher ein sicherer Startwert}}.',
    manual: 'Von Hand gesetzt.',
    unit: 'GB',
    autoButton: 'Auto',
    autoTip: 'Die erkannte Grenze verwenden',
    autoActive: 'Die erkannte Grenze ist bereits gewählt',
  },
  workers: {
    label: 'Rechen-Worker',
    desc: 'Wie viele Bilder oder Blöcke gleichzeitig verarbeitet werden. Weniger brauchen weniger Speicher. Automatisch nutzt auf diesem Rechner bis zu {n, number}.',
    auto: 'Automatisch ({n, number})',
  },
  gpu: {
    label: 'GPU verwenden',
    recommended: 'Empfohlen',
    desc: 'An, wenn dieser Browser WebGPU bietet. Matching und die dichten Schritte laufen, wo sie können, auf der Grafikkarte, sonst auf der CPU.',
  },
  keepAwake: {
    label: 'Bildschirm während eines Laufs anlassen',
    desc: 'Verhindert, dass der Bildschirm und auf den meisten Systemen der Rechner in den Ruhezustand gehen, während ein Schritt oder Workflow läuft. Wirkt, solange der WebSfM-Tab sichtbar ist.',
  },
  notify: {
    label: 'Benachrichtigen, wenn ein Lauf endet',
    desc: 'Eine Desktop-Benachrichtigung, wenn ein Lauf von 30 Sekunden oder mehr endet oder ein Workflow Sie braucht, während der WebSfM-Tab im Hintergrund ist.',
    blocked:
      'Benachrichtigungen sind für diese Seite blockiert. Erlauben Sie sie in den Website-Einstellungen des Browsers und schalten Sie dies dann ein.',
    notGranted:
      'Der Browser hat Benachrichtigungen nicht erlaubt. Schalten Sie dies erneut ein, um noch einmal gefragt zu werden.',
  },

  storage: {
    label: 'Browserspeicher',
    desc: 'Projekte in diesem Browser, ihre abgeleiteten Dateien, heruntergeladene KI-Modelle und alles andere, was diese Seite speichert.',
    used: '{used} von {quota} belegt, die dieser Seite zur Verfügung stehen',
    unavailable: 'Dieser Browser meldet seine Speicherbelegung nicht.',
    readFailed: 'Das Lesen der Speicherbelegung ist fehlgeschlagen: {error}',
  },
  durable: {
    label: 'Speicherschutz',
    desc: 'Dauerhafter Speicher macht es unwahrscheinlicher, dass der Browser hier gespeicherte Projekte löscht, wenn die Festplatte fast voll ist. Der Browser entscheidet das selbst, meist ohne zu fragen, danach, wie oft die Seite genutzt wird.',
    protected: 'Geschützt',
    request: 'Anfordern',
    requesting: 'Wird angefordert…',
    unavailable: 'Nicht verfügbar',
    busy: 'Warten Sie, bis die Anfrage abgeschlossen ist',
    granted: 'Dauerhafter Speicher ist an.',
    declined:
      'Der Browser hat vorerst abgelehnt. Die meisten Browser erlauben es von selbst, ohne zu fragen, sobald die Seite oft genutzt, als Lesezeichen gespeichert oder als App installiert wird. Projekte werden weiter normal gespeichert, können aber gelöscht werden, wenn der Speicherplatz ausgeht. Sie können es später erneut versuchen.',
    failed: 'Das Anfordern von dauerhaftem Speicher ist fehlgeschlagen: {error}',
  },
  models: {
    label: 'Heruntergeladene KI-Modelle',
    none: 'Keine heruntergeladen. Ein Schritt, der ein Modell braucht, bietet den Download an.',
    some: 'Heruntergeladen: {names}. Jedes wird erst wieder geladen, wenn ein Schritt es braucht.',
    checking: 'Wird geprüft…',
    clear: 'Modelle löschen',
    nothing: 'Es sind keine Modelle heruntergeladen',
    confirmTitle: 'Heruntergeladene Modelle entfernen?',
    confirmMessage:
      'Die heruntergeladenen KI-Modelle entfernen? Sie werden erneut geladen, wenn ein Schritt sie braucht. Projekte sind nicht betroffen.',
    removed: 'Die heruntergeladenen KI-Modelle wurden entfernt.',
    failed: 'Das Entfernen der heruntergeladenen Modelle ist fehlgeschlagen: {error}',
  },
  presets: {
    label: 'Dialog-Presets',
    desc: '{n, plural, one {# Preset} other {# Presets}}, gespeichert mit Presets ▾ in der Titelleiste eines Dialogs. Sie gehören zu diesem Browser; Exportieren nimmt sie mit.',
    none: 'Noch keine gespeichert. Presets ▾ in der Titelleiste eines Dialogs speichert seine Einstellungen unter einem Namen.',
    rename: 'Umbenennen',
    delete: 'Löschen',
    save: 'Speichern',
    newName: 'Neuer Name des Presets',
    deleteTitle: 'Preset löschen?',
    deleteMessage: 'Das Preset „{name}“ löschen? Damit gemachte Läufe bleiben, wie sie sind.',
    error: {
      empty: 'Geben Sie dem Preset einen Namen',
      taken: 'Dieser Dialog hat schon ein Preset mit diesem Namen',
      missing: 'Das Preset gibt es nicht mehr',
    },
  },
  transfer: {
    label: 'Einstellungen und Presets',
    desc: 'Ihre Einstellungen, Dialog-Presets und Workflow-Vorlagen in eine Datei speichern, um sie in einen anderen Browser oder auf einen anderen Rechner mitzunehmen. Speichergrenze, Worker und GPU-Schalter bleiben bei diesem Rechner.',
    export: 'Exportieren',
    import: 'Importieren…',
    busy: 'Warten Sie, bis der Lauf, das Öffnen oder das Speichern abgeschlossen ist: WebSfM lädt dafür neu',
    importTitle: 'Einstellungen importieren?',
    importMessage:
      'Die Einstellungen aus „{name}“ importieren? Ihre Einstellungen werden ersetzt; Dialog-Presets und Workflow-Vorlagen kommen zu Ihren hinzu und ersetzen gleichnamige. Danach lädt WebSfM neu.',
    importConfirm: 'Importieren und neu laden',
    notSettings: '„{name}“ ist keine Einstellungsdatei von WebSfM. Erstellen Sie eine mit Exportieren auf diesem Tab.',
    newer:
      '„{name}“ wurde von einer neueren Version von WebSfM gespeichert. Aktualisieren Sie WebSfM und importieren Sie sie dann.',
    exportFailed: 'Das Exportieren der Einstellungen ist fehlgeschlagen: {error}',
    importFailed: 'Das Importieren der Einstellungen ist fehlgeschlagen: {error}',
    resetLabel: 'Alle Einstellungen zurücksetzen',
    resetDesc:
      'Jede Einstellung auf ihren Standard zurücksetzen, auch das Layout (Breite der Seitenleiste, Konsole, offene Schritte). Projekte, Dialog-Presets und Workflow-Vorlagen bleiben.',
    reset: 'Zurücksetzen',
    resetTitle: 'Alle Einstellungen zurücksetzen?',
    resetMessage:
      'Jede Einstellung auf ihren Standard zurücksetzen? Projekte, Dialog-Presets und Workflow-Vorlagen bleiben. Danach lädt WebSfM neu.',
    resetConfirm: 'Zurücksetzen und neu laden',
    resetFailed: 'Das Zurücksetzen der Einstellungen ist fehlgeschlagen: {error}',
  },
}
