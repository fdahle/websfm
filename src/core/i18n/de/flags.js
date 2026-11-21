// Deutsch: Debug ▸ Flags (en/flags.js ist die Referenz). Namen, Werte und Hilfe der Flags
// sind Code (tuning.js) und bleiben englisch, wie in der Konsole.
export default {
  title: 'Flags',
  ariaLabel: 'Flags: interne Abstimmungswerte',
  changed: '{n, plural, =0 {Keine Flags geändert} one {# Flag geändert} other {# Flags geändert}}',
  intro:
    'Die internen Werte, mit denen WebSfM abgestimmt ist, zum Testen. Wer einen ändert, ändert die Ergebnisse, ' +
    'und nichts hier wird geprüft, wie ein Dialog seine Einstellungen prüft. Die Einstellungen für ein Projekt ' +
    'stehen in den Dialogen. Eine Änderung gilt ab dem nächsten Lauf und wird nicht mit dem Projekt gespeichert.',
  search: { placeholder: 'Namen und Hilfe durchsuchen…', label: 'Flags durchsuchen' },
  tree: {
    label: 'Gruppen',
    group: { sfm: 'Sparse-Modell', match: 'Feature-Matching' },
    other: 'Sonstige',
    changedTip: '{n, plural, one {# Flag geändert} other {# Flags geändert}}',
  },
  results: '{n, plural, =0 {Kein Flag passt zur Suche} one {# Treffer} other {# Treffer}}',
  col: { name: 'Name', value: 'Wert', default: 'Standard', type: 'Typ' },
  type: { number: 'Zahl', boolean: 'an/aus', text: 'Text', choice: 'Auswahl', list: 'Liste (JSON)' },
  auto: 'automatisch',
  autoHint: 'leer: automatisch',
  reset: 'Zurücksetzen',
  resetTip: 'Zurück auf den Standard, {value}',
  resetAll: 'Alle zurücksetzen',
  resetAllTip: 'Jedes Flag zurück auf seinen Standard',
  resetAllNone: 'Kein Flag ist geändert',
  confirm: {
    title: 'Alle Flags zurücksetzen?',
    message:
      '{n, plural, one {Das geänderte Flag geht} other {Alle # geänderten Flags gehen}} zurück auf den Standard.',
  },
  keep: 'Nach dem Neuladen behalten (nur dieser Browser)',
  keepTip:
    'Die geänderten Flags in diesem Browser speichern, damit sie nach dem Neuladen weiter gelten. Sie werden nie mit dem Projekt gespeichert.',
  help: {
    title: 'Aus tuning.js',
    none: 'Eine Zeile wählen, um den Kommentar darüber in tuning.js zu lesen.',
    missing: 'tuning.js hat keinen Kommentar zu diesem Wert.',
    shared: 'Der Kommentar zu {key}, den dieser Wert teilt:',
  },
  invalid: {
    number: 'Eine endliche Zahl eingeben',
    numberOrEmpty: 'Eine endliche Zahl eingeben, oder leer lassen für automatisch',
    text: 'Einen Wert eingeben',
    list: 'Eine JSON-Liste eingeben, etwa {example}',
    refused: 'Abgelehnt: {reason}',
  },
  marker: {
    label: '{n, plural, one {# Flag geändert} other {# Flags geändert}}',
    tip: 'Interne Abstimmungswerte sind geändert, die Ergebnisse können daher vom Standard abweichen. Klicken öffnet Weiteres ▸ Debug ▸ Flags.',
  },
  note: {
    text: '{n, plural, one {Ein interner Abstimmungswert ist geändert} other {# interne Abstimmungswerte sind geändert}} (Weiteres ▸ Debug ▸ Flags); ein Lauf mit ihnen nennt sie in seinem Protokoll:',
    item: '{key}={value} (Standard {def})',
  },
}
