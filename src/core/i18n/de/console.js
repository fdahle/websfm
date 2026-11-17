// Die Konsole (components/layout/DevConsole.vue): Reiter, Knöpfe und Filter. Die
// Zeilen des Protokolls und die Antworten auf Befehle bleiben englisch.
export default {
  tab: {
    pipeline: 'Pipeline',
    activity: 'Aktivität',
    all: 'Alle',
  },
  source: {
    label: 'src',
    title: 'Die Quelle jeder Zeile zeigen oder verbergen',
  },
  detail: {
    label: 'Details',
    title: 'Die ausführlichen (Debug-)Zeilen zeigen: eine je Bild, Paar oder Iteration',
  },
  filter: {
    label: 'Filter',
    title: 'Nur einige Quellen zeigen',
    heading: 'Quellen',
    all: 'Alle',
    none: 'Keine',
    empty: 'Noch keine Quellen.',
  },
  save: {
    label: 'TXT speichern',
    title: 'Das Protokoll als TXT-Datei speichern',
    options: 'Optionen für den Export',
    include: 'Im Export enthalten',
    activity: 'Aktivität (Ihre Änderungen)',
    debug: 'Ausführliche (Debug-)Zeilen',
  },
  clear: {
    label: 'Leeren',
    title: 'Das Protokoll leeren, nach Rückfrage',
    confirmTitle: 'Die Konsole leeren?',
    confirmMessage:
      'Jede Zeile des Protokolls dieses Projekts löschen, auch die gespeicherte Kopie? TXT speichern behält vorher eine Kopie. Das lässt sich nicht rückgängig machen.',
  },
  activity: {
    glyph: 'Ihre Änderung',
    command: 'Ihre Änderung. Der Konsolenbefehl dafür: {command}',
  },
  empty: {
    none: 'Noch keine Ausgabe.',
    activity: 'Noch keine Aktivität: Ihre Änderungen erscheinen hier.',
    filtered: 'Keine Zeile passt zum Filter.',
  },
  jump: {
    label: '↓ Neue Zeilen',
    title: 'Zu den neuesten Zeilen springen',
  },
  prompt: 'Einen Befehl eingeben, oder „help“',
}
