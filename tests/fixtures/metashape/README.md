Metashape 2.2.2 exports of the Aukerman example (`npm run fetch:examples`, CC0, OpenDroneMap
odm_data_aukerman): 42 photos at 2400 px aligned with their EXIF GPS, three markers placed on
tie points (GCP3 a check point), optimised (f, cx, cy, k1–k3, p1, p2).

- `aukerman-markers.xml`: File ▸ Export ▸ Export Markers (WGS 84), which holds the sensors and
  cameras as well.
- `aukerman-opk-utm17n.json`: Export Cameras ▸ Omega Phi Kappa in EPSG:32617, the values
  `core/io/metashapeXml.js` has to reproduce.
