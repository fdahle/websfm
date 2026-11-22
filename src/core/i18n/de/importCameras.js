// Import ▸ Kameraparameter (components/modals/import/CameraImportModal.vue).
export default {
  title: 'Kameraparameter importieren',
  delimiter: 'Trennzeichen',
  header: 'Erste Zeile ist eine Kopfzeile',
  focalUnit: 'Brennweite in',
  unit: { mm: 'mm', px: 'Pixel' },
  sourceCrs: 'Quell-KBS dieser Positionen',
  datum: 'Höhenbezug',
  datumTip:
    'Worauf sich die Höhen beziehen. RTK- und GNSS-Empfänger liefern ellipsoidische Höhen, sofern kein ' +
    'Geoidmodell eingestellt ist. Liegen die GCPs in einem anderen Bezug, rechnet Sparse Model mit einem ' +
    'angegebenen Bezug die Höhen exakt um, statt den Versatz zwischen beiden zu schätzen.',
  mapping: 'Spaltenzuordnung',
  poseNote:
    'Genauigkeiten sind 1σ-Werte. Positionsgenauigkeiten stützen die Rekonstruktion, Orientierungsgenauigkeiten ' +
    'Omega, Phi und Kappa.',
  ignore: 'Ignorieren',
  abs: 'Abs {axis}',
  targets: 'Ziel',
  targetFor: 'Ziel für importierten Sensor {n, number}',
  newSensor: 'Neuer Sensor',
  updateSensor: '{name} aktualisieren ({n, plural, one {# Bild} other {# Bilder}})',
  sensorImages: '{first} +{n, number} weitere',
  sensorAt: 'Sensor {n, number} der Datei',
  sensorOnly: 'Sensor der Datei',
  part: {
    focal: 'f {f} {unit}',
    size: '{w}×{h} px',
    pixel: 'Pixel {size} mm',
    principal: 'Hauptpunkt',
    lens: 'Objektiv {model}',
    distortion: 'Verzeichnung',
    marks: '{n, plural, one {# Rahmenmarke} other {# Rahmenmarken}}',
  },
  outcomeNew:
    '{n, plural, =0 {Neuer Sensor, noch keine Bilder zugeordnet} one {Neuer Sensor, # Bild zugeordnet} other {Neuer Sensor, # Bilder zugeordnet}}',
  outcomeUpdate:
    'Aktualisiert {name}{why, select, label { (gleiche Bezeichnung)} images { (der Sensor genau dieser Bilder)} sole { (der einzige Sensor des Projekts)} other {}}' +
    '{n, plural, =0 {} one {, # Bild zugeordnet} other {, # Bilder zugeordnet}}',
  unmatched: '· {n, plural, one {# Bildname} other {# Bildnamen}} nicht im Projekt',
  emptied:
    '{names} {n, plural, one {behält} other {behalten}} keine Bilder; in der Sensortabelle entfernen, wenn nicht mehr gebraucht.',
  sensors: '{n, plural, one {# Sensor} other {# Sensoren}}',
  poses: '{n, plural, one {# Pose} other {# Posen}}',
  skipped: ' · {n, plural, one {# Zeile} other {# Zeilen}} übersprungen',
  needIntrinsic: 'Mindestens eine Spalte der inneren Orientierung zuordnen (Brennweite, Abmessungen …).',
  needImage: 'Eine Spalte <strong>Bildname</strong> zuordnen.',
  needXY: 'Spalten <strong>Abs {x}</strong> und <strong>Abs {y}</strong> zuordnen.',
  reason: {
    noSensors: 'Die Datei enthält keine Kamerakalibrierung',
    noImage: 'Die Spalte mit den Bildnamen wählen',
    noXY: 'Die X- und Y-Spalte wählen',
    noRows: 'Keine Zeile mit einer Position gefunden',
  },
  importCalibration: 'Kalibrierung importieren',
  importPoses: 'Posen importieren',
}
