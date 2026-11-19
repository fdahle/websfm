// Deutsch: Genauigkeit nach jeder Einpassung (en/accuracy.js ist die Referenz).
export default {
  title: 'Seit der Einpassung davor',
  empty:
    'Noch keine Einpassung aufgezeichnet. Das Modell georeferenzieren; jede Einpassung danach wird hier zum Vergleich behalten.',
  first: 'Die erste aufgezeichnete Einpassung; die nächste wird mit ihr verglichen.',
  fitted: 'Eingepasst {when} an {method}',
  method: {
    'gcps': 'die GCPs',
    'poses': 'die Kamerapositionen',
    'dem-hold': 'ein Referenz-DEM',
    'other': 'das Modell',
  },
  change: 'Davor wurde das Modell geändert: {change}.',
  controlsAdded: 'Passpunkte hinzugekommen: {names}.',
  controlsRemoved: 'Nicht mehr verwendete Passpunkte: {names}.',
  checksAdded: 'Checkpoints hinzugekommen: {names}.',
  checksRemoved: 'Nicht mehr verwendete Checkpoints: {names}.',
  metric: {
    checkpoints: 'Checkpoints ({n, number})',
    loo: 'Passpunkte, reihum ausgelassen ({n, number})',
    cameras: 'Kamerapositionen ({n, number})',
  },
  axis: { h: 'horizontal', v: 'vertikal' },
  value: '{v, number, ::.000} {unit}',
  verdict: {
    better: '▲ besser',
    worse: '▼ schlechter',
    same: '· gleich',
    changed: 'an anderen Punkten: nicht vergleichbar',
    new: 'neu',
    gone: 'nicht mehr gemessen',
  },
  noIndependent:
    'Keine unabhängige Prüfung: Der Fehler eines Passpunkts schrumpft immer, wenn er verwendet wird. Einige GCPs als ' +
    'Checkpoints markieren oder vier oder mehr Passpunkte verwenden, damit jeder reihum ausgelassen werden kann.',
  why:
    'Checkpoints gehen nie in die Einpassung ein. Bei vier oder mehr Passpunkten wird jeder aus einer Einpassung ohne ' +
    'ihn vorhergesagt. Die Kamerapositionen zählen nur, wenn an die GCPs eingepasst wurde.',
  history: 'Alle Einpassungen',
  col: {
    when: 'Wann',
    method: 'Eingepasst an',
    change: 'Modell geändert durch',
    points: 'Pass- / Checkpunkte',
    checkpoints: 'Checkpoints H / V',
    loo: 'Reihum ausgelassen H / V',
    cameras: 'Kameras H / V',
  },
  pair: '{h, number, ::.000} / {v, number, ::.000}',
}
