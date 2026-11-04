Metashape 2.2.2 exports of the Aukerman example (`npm run fetch:examples`, CC0, OpenDroneMap
odm_data_aukerman): 42 photos at 2400 px aligned with their EXIF GPS, three markers placed on
tie points (GCP3 a check point), optimised (f, cx, cy, k1–k3, p1, p2), then three scale bars
added (GCP1–GCP2 12.345 m ± 2 mm; GCP2–GCP3 20.5 m, disabled as a check; between the first two
cameras 3.25 m).

- `aukerman-markers.xml`: File ▸ Export ▸ Export Markers (WGS 84), which holds the sensors and
  cameras as well.
- `aukerman-opk-utm17n.json`: Export Cameras ▸ Omega Phi Kappa in EPSG:32617, the values
  `core/io/metashapeXml.js` has to reproduce.
- `aukerman-tiepoints.psz`: a Metashape 2.2.2 project of six Aukerman photos (DSC00290–295,
  2400 px), matched at downscale 4 and aligned (three of six), with a marker, depth maps,
  a dense cloud and a mesh; trimmed to its `doc.xml` (photo paths reduced to the file
  names), tie points (`tracks0.ply`, `points0.ply`, `projections*.ply`) and mesh
  (`model0.ply`). Metashape's own `camera.project` on it: median 0.856, p90 2.195, max
  11.175 px over 349 projections.
