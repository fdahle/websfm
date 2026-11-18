// Deutsch: die Export-Dialoge (en/export.js ist die Referenz).
export default {
  title: {
    cloud: 'Punktwolke exportieren',
    mesh: 'Mesh exportieren',
    model: 'Modell exportieren',
    colmap: 'SfM-Projekt exportieren',
    tiles3d: '3D Tiles exportieren',
    undistorted: 'Entzerrte Bilder exportieren',
    dem: 'DEM exportieren',
    measurements: 'Messungen exportieren',
    ortho: 'Orthofoto exportieren',
    poses: 'Kameraposen exportieren',
    sensors: 'Kalibrierung exportieren',
    cameraFiducials: 'Kamera-Fiducials exportieren',
    imageFiducials: 'Bild-Fiducials exportieren',
    keypoints: 'Keypoints exportieren',
    matches: 'Matches exportieren',
    vectors: 'Vektorebene exportieren',
    footprints: 'Footprints exportieren',
    allmaps: 'Nach Allmaps exportieren',
  },
  hint: {
    colmap:
      'Ein vollständiger COLMAP-Workspace, seine Feature-Datenbank, ein Sparse-Modell oder Kameratransformationen für ' +
      'NeRF- und Gaussian-Splatting-Werkzeuge. Nicht unterstützte Deskriptor-Kodierungen entfallen; Keypoints und ' +
      'verifizierte Matches bleiben.',
    tiles3d:
      'Für Globus-Viewer (Cesium und alles, was 3D Tiles 1.1 liest). Das Modell wird mit einer aus dem Projekt-CRS ' +
      'gemessenen Transformation platziert und liegt so auch in Polnähe richtig.',
    undistorted:
      'Lochkamera-Bilder und ein PINHOLE-Sparse-Modell, die Übergabe, die COLMAPs image_undistorter erzeugt (für ' +
      'OpenMVS, MVE und MVS-Texturing), und eine transforms.json für NeRF und 3D Gaussian Splatting. Verzeichnung und ' +
      'Filmscan-Geometrie sind schon aus dem Modell herausgerechnet; nur die Pixel werden neu abgetastet.',
    sensors: 'Import ▸ Kalibrierung liest sie wieder ein: eine Zeile pro Kameragruppe oder pro Bild.',
    cameraFiducials:
      'Die kalibrierten Marken jeder Filmkamera in Millimetern, eine Zeile pro Marke. Import ▸ Kamera-Fiducials liest ' +
      'sie wieder ein.',
    imageFiducials:
      'Die erkannten oder gesetzten Fiducials jedes Scans in Pixeln, eine Zeile pro Marke. Import ▸ Bild-Fiducials ' +
      'liest sie wieder ein.',
    matches: 'Die Paare, deren Matches die geometrische Prüfung bestanden haben; ein verworfenes Paar hat keine.',
    allmaps:
      'Eine Georeference Annotation pro ausgerichtetem Foto, in einer Datei. Öffnen Sie sie im Allmaps Viewer ' +
      '(einfügen oder ihre Adresse angeben): Jedes Foto wird von Ihrem IIIF-Bildserver geladen und mit seinen ' +
      'Passpunkten auf die Karte entzerrt, die dem Gelände und dem Objektiv folgen wie Fotos auf der 2D-Karte.',
  },
  format: {
    cloud: {
      'ply-binary': { label: 'PLY', blurb: 'binär (kompakt)' },
      'ply-ascii': { label: 'PLY', blurb: 'ASCII (Text)' },
      'las': { label: 'LAS 1.2', blurb: 'Vermessungsstandard' },
      'laz': { label: 'LAZ', blurb: 'komprimiertes LAS (5–10× kleiner)' },
      'copc': {
        label: 'COPC',
        blurb: 'Cloud-optimiertes LAZ (streamt in QGIS, Potree)',
        hint:
          'LAZ 1.4 als Level-of-Detail-Octree: QGIS, Potree, PDAL und WebSfM lesen nur den gezeigten Teil, so öffnet ' +
          'sich auch eine große Punktwolke sofort.',
      },
      'xyz': { label: 'XYZ', blurb: 'reiner Text (x y z r g b)' },
    },
    mesh: {
      'ply-binary': { label: 'PLY', blurb: 'binär (Flächen)' },
      'ply-ascii': { label: 'PLY', blurb: 'ASCII (Text)' },
      'glb': { label: 'glTF binär', blurb: '.glb' },
      'obj': { label: 'Wavefront OBJ', blurb: '.obj' },
      'stl': { label: 'STL', blurb: 'binär (ohne Farbe)' },
    },
    model: {
      json: { label: 'JSON', blurb: 'Kameras + Tracks' },
      transforms: {
        label: 'transforms.json',
        blurb: 'NeRF / 3DGS',
        hint:
          'Kamera-zu-Welt-Posen (OpenGL-Konvention) + innere Orientierung für nerfstudio, instant-ngp und 3D Gaussian ' +
          'Splatting. Lokaler SfM-Rahmen; Lochkamera.',
      },
    },
    colmap: {
      workspace: { label: 'COLMAP-Workspace', blurb: 'Datenbank + Sparse-Modell' },
      database: { label: 'COLMAP database.db', blurb: 'Kameras + Features + Matches' },
      txt: { label: 'Text (.txt)', blurb: 'gezippt' },
      bin: { label: 'Binär (.bin)', blurb: 'gezippt' },
      transforms: { label: 'transforms.json', blurb: 'NeRF / 3DGS' },
      openmvg: { label: 'OpenMVG sfm_data.json' },
      nvm: { label: 'VisualSFM NVM v3' },
      metashape: {
        label: 'Metashape XML',
        blurb: 'Kameras, Kalibrierung, Marker',
        hint:
          'In Agisoft Metashape mit „Kameras importieren“ (Menü Datei) einlesen, dann „Marker importieren“: die ' +
          'registrierten Kameras mit ihrer Kalibrierung und die GCPs mit ihren Marken. In WGS 84, wenn das Projekt ' +
          'georeferenziert ist.',
      },
    },
    tiles3d: {
      tileset: { label: 'Cesium 3D Tiles 1.1', blurb: 'tileset.json + glTF-Kacheln (.zip)' },
    },
    undistorted: {
      jpeg: { label: 'JPEG', blurb: 'kompakt (empfohlen für MVS)' },
      png: { label: 'PNG', blurb: 'verlustfrei (viel größer)' },
    },
    dem: {
      geotiff: { label: 'GeoTIFF (.tif)', blurb: 'georeferenziert' },
      cog: {
        label: 'Cloud-Optimized GeoTIFF',
        blurb: 'gekachelt + Übersichten',
        hint:
          'Intern gekachelt mit halbierten Übersichtsstufen, sodass ein Viewer eine Vorschau oder einen Ausschnitt mit ' +
          'wenigen Range-Anfragen holen kann statt der ganzen Datei. Überall lesbar, wo ein normales GeoTIFF lesbar ist.',
      },
      asc: { label: 'ESRI-ASCII-Raster', blurb: '.asc' },
      png: { label: 'Schummerungs-PNG + World-Datei' },
      support: { label: 'Stützungs-GeoTIFF (.tif)', blurb: '% jeder Zelle gemessen' },
    },
    measurements: {
      csv: { label: 'CSV', blurb: 'eine Zeile pro Messung, Einheiten in Spalten' },
      geojson: { label: 'GeoJSON', blurb: 'Linien und Polygone mit ihren Werten' },
    },
    ortho: {
      geotiff: { label: 'GeoTIFF (.tif)', blurb: 'georeferenziert' },
      cog: {
        label: 'Cloud-Optimized GeoTIFF',
        blurb: 'gekachelt + Übersichten',
        hint:
          'Intern gekachelt mit halbierten Übersichtsstufen und DEFLATE-Kompression: das Orthofoto genau so, wie es ' +
          'gespeichert ist, für Web und GIS. Überall lesbar, wo ein normales GeoTIFF lesbar ist.',
      },
      png: { label: 'PNG + World-Datei', blurb: '.wld' },
      jpeg: { label: 'JPEG + World-Datei' },
      mbtiles: {
        label: 'MBTiles',
        blurb: 'Webkarten-Kacheln (QGIS, QField, MapLibre)',
        hint:
          'Web-Mercator-Kacheln in einer Datei, von der Zoomstufe, die das ganze Gebiet zeigt, bis zu der, die so fein ' +
          'ist wie das Orthofoto: für eine Offline-Feldkarte oder eine Webkarte.',
      },
      xyz: {
        label: 'XYZ-Kacheln (.zip)',
        blurb: "'{z}/{x}/{y}'-Ordner",
        hint: 'Dieselben Kacheln als einzelne Dateien, für einen Webserver oder eine statische Webkarte.',
      },
    },
    poses: {
      csv: { label: 'CSV', blurb: 'eine Zeile pro Kamera' },
      txt: { label: 'Text (.txt)', blurb: 'tabulatorgetrennt' },
      geojson: { label: 'GeoJSON', blurb: 'ein Punkt pro Kamera, für GIS' },
    },
    sensors: {
      csv: { label: 'CSV' },
      txt: { label: 'Text (.txt)', blurb: 'tabulatorgetrennt' },
    },
    cameraFiducials: {
      csv: { label: 'CSV' },
      txt: { label: 'Text (.txt)', blurb: 'tabulatorgetrennt' },
    },
    imageFiducials: {
      csv: { label: 'CSV' },
      txt: { label: 'Text (.txt)', blurb: 'tabulatorgetrennt' },
    },
    keypoints: {
      json: {
        label: 'JSON',
        blurb: 'ein Eintrag pro Bild',
        hint: 'Position (Pixel), Skala und Antwort jedes Keypoints.',
      },
      csv: {
        label: 'CSV',
        blurb: 'eine Zeile pro Keypoint',
        hint: 'image, x, y, scale, response: eine Zeile pro Keypoint, für eine Tabellenkalkulation oder pandas.',
      },
    },
    matches: {
      json: { label: 'JSON', blurb: 'ein Eintrag pro Paar' },
      csv: { label: 'CSV', blurb: 'eine Zeile pro Match' },
    },
    vectors: {
      geojson: { label: 'GeoJSON', blurb: '.geojson' },
      kml: { label: 'KML (.kml)', blurb: 'Google Earth, WGS 84' },
    },
    allmaps: {
      annotations: { label: 'Georeference Annotations', blurb: 'IIIF-JSON für Allmaps' },
    },
  },
  unavailable: {
    needsCrs: 'braucht ein Projekt-CRS',
    tooLarge: 'zu groß (höchstens {side, number}² px); nehmen Sie ein GeoTIFF',
  },
  frame: {
    georef: 'Georeferenzieren (ins Projekt-CRS transformieren)',
    scaleOrient: 'Maßstab und Orientierung anwenden (Meter, horizontiert — ohne CRS)',
    scale: 'Maßstab anwenden (Meter schreiben — ohne CRS)',
    orient: 'Orientierung anwenden (horizontiert, mit Ihrem Ursprung und Ihrer Richtung — Modelleinheiten)',
  },
  step: {
    format: 'Format',
    file: 'Datei',
    crs: 'Koordinatensystem',
    options: {
      allmaps: 'IIIF-Bilder',
      tiles3d: 'Kacheln',
      undistorted: 'Bilder',
      dem: 'Zellen',
      ortho: 'Pixel',
      measurements: 'Koordinaten',
      vectors: 'Koordinaten',
      other: 'Inhalt',
    },
  },
  exporting: '<strong>{name}</strong> wird exportiert',
  source: {
    label: 'Quelle',
    noSparse: 'Zuerst ein Sparse-Modell erstellen (Rekonstruktion ▸ Sparse-Modell)',
    posesEstimated: 'Von der Rekonstruktion geschätzt ({n, plural, one {# Kamera} other {# Kameras}})',
    posesImported: 'Importierte Posen ({n, plural, one {# Pose} other {# Posen}})',
    noImportedPoses: 'Keine Kameraposen importiert (Import ▸ Kameraposen)',
    sensorsEstimated: 'Von der Rekonstruktion geschätzt, eine Zeile pro Kameragruppe',
    sensorsEstimatedPerImage:
      'Von der Rekonstruktion geschätzt, eine Zeile pro Bild ({n, plural, one {# Kamera} other {# Kameras}})',
    sensorsEntered: 'Wie eingegeben ({n, plural, one {# Kameragruppe} other {# Kameragruppen}})',
    noEnteredCalibration: 'Keine Kameragruppe hat eine eingegebene Kalibrierung',
  },
  supportLayer: {
    label: 'Stützungsebene',
    effect:
      ': für jede DEM-Zelle der Prozentsatz, in den Punkte fielen (0 = interpoliert), 255, wo das DEM leer ist. Im ' +
      'Raster des DEMs, oder in seiner Übersicht bei einem DEM, das für eine Ebene zu groß ist.',
  },
  cloud: {
    colours: 'Punktfarben mitschreiben',
    lasColours: 'Punktfarben mitschreiben (LAS speichert RGB immer, wenn die Punktwolke Farbe hat)',
    lasAlwaysRgb: 'LAS speichert RGB immer, wenn die Punktwolke Farbe hat',
    voxel: {
      label: 'Voxel-Ausdünnungszelle',
      hint: 'Welteinheiten; 0 = jeden Punkt behalten.',
      hintGeoref: 'Welteinheiten (Projekt-CRS, wenn georeferenziert); 0 = jeden Punkt behalten.',
      hintScaled: 'Welteinheiten (Meter, wenn skaliert); 0 = jeden Punkt behalten.',
    },
    attributes:
      'Punktattribute (eine berechnete Distanz, importierte Intensität oder Klassifikation) werden in PLY und LAS ' +
      'geschrieben. LAZ behält nur die Standard-LAS-Felder, XYZ keine.',
  },
  mesh: {
    texture: 'Die Fototextur mitschreiben',
    textureOnly: 'Die Fototextur mitschreiben (nur GLB oder OBJ)',
    textureFormats: 'Nur GLB und OBJ tragen eine Textur',
    glbTexture: 'Die Atlasseiten sind in die .glb eingebettet.',
    objTexture: 'Lädt eine .zip mit der .obj, ihrer .mtl und einem JPEG pro Atlasseite herunter.',
    colours: 'Eckpunktfarben mitschreiben',
    stlColours: 'Eckpunktfarben mitschreiben (STL hat keine Farbe)',
    stlNoColour: 'STL hat keine Farbe',
  },
  model: { tracks: 'Punkt-Tracks mitschreiben (Bildbeobachtungen)' },
  colmap: { images: 'Originale Quellbilder mitschreiben (größere ZIP)' },
  tiles3d: {
    tiling: 'Kachelung',
    lod: 'Level of Detail (Kachelhierarchie)',
    single: 'Eine Kachel',
    singleTooLarge: 'Eine Kachel — zu groß für eine Kachel',
    tooLarge: 'Zu groß für eine Kachel',
    lodMesh: 'Das Mesh in Kacheln geteilt und pro Stufe vereinfacht; Viewer laden Details dort, wo die Kamera ist.',
    lodCloud: 'Eine Kachel pro Knoten des Level-of-Detail-Octrees; Viewer laden Details dort, wo die Kamera ist.',
    singleHint: 'Das ganze Modell in einer Kachel, auf einmal geladen.',
    triangles: 'Dreiecke pro Kachel',
    textureLod: 'Die feinsten Kacheln behalten die Fototextur; die gröberen, vereinfachten haben Eckpunktfarben.',
    textureSingle: 'Die Kachel ist das ausgewählte texturierte Mesh, mit seiner Fototextur.',
    colours: 'Eckpunktfarben mitschreiben',
    streamed:
      'Eine gestreamte Punktwolke wird in ihren eigenen Koordinaten geschrieben und im CRS platziert, das ihre Datei ' +
      'nennt, sonst im Projekt-CRS.',
    noGeoref:
      'Dieses Projekt hat keine Georeferenz, daher hat das Tileset keine Position auf dem Globus. Georeferenzieren ' +
      'Sie zuerst das Modell.',
  },
  undistorted: {
    border: 'Rand',
    borderHint: 'Zuschneiden behält nur den Bereich, der innerhalb des Quellbildes abtastet.',
    crop: 'Auf den gültigen Bereich zuschneiden',
    full: 'Das volle Bild behalten (leere Ränder)',
    quality: 'JPEG-Qualität: {q, number, ::.00}',
    maxDim: 'Größte Abmessung',
    maxDimHint: 'Längste Ausgabeseite in Pixeln; 0 = native Auflösung. Senken für eine kleinere ZIP.',
  },
  raster: {
    nodata: 'NODATA-Wert',
    nodataHint: 'Für leere Zellen geschrieben (Löcher ohne Messung).',
    compression: 'Kompression',
    none: 'Keine (unkomprimiert)',
    deflate: 'DEFLATE (verlustfrei)',
    alpha: 'Alphakanal (transparente leere Pixel)',
    tileFormat: 'Kachelformat',
    tilePng: 'PNG — transparente Ränder',
    tileJpeg: 'JPEG — kleiner, weiße Ränder',
    tileWebp: 'WebP — klein, transparent (neuere Viewer)',
    jpegQuality: 'JPEG-Qualität: {q, number, ::.00}',
    tileQuality: 'Kachelqualität: {q, number, ::.00}',
    crs: 'Koordinatensystem',
    crsHint: 'Ein anderes CRS schreibt eine umprojizierte Kopie; das Produkt selbst bleibt, wie es erstellt wurde.',
    localHint: 'Ein Raster im lokalen Rahmen hat kein CRS, aus dem umprojiziert werden kann.',
    asBuilt: 'Wie erstellt ({crs})',
    localFrame: 'lokaler Rahmen, kein CRS',
    anotherCrs: 'Anderes CRS…',
    resampling: 'Resampling',
    bilinear: 'Bilinear',
    nearest: 'Nächster Nachbar',
    resamplingDem: 'Bilinear interpoliert Höhen; Nächster Nachbar behält jeden Wert wie gemessen.',
    resamplingOrtho: 'Bilinear ist glatter; Nächster Nachbar behält jedes Pixel, wie es war.',
    reprojectedDem:
      'Als Cloud-Optimized GeoTIFF geschrieben (DEFLATE, NODATA NaN) mit derselben Bodenzellgröße. Höhen behalten ' +
      'ihr Höhendatum: nur das horizontale CRS ändert sich.',
    reprojectedOrtho: 'Als Cloud-Optimized GeoTIFF geschrieben (DEFLATE) mit derselben Bodenzellgröße.',
  },
  measurements: {
    coordinates: 'Koordinaten',
    project: 'Projekt-CRS ({crs}), mit Höhen',
    wgs84: 'WGS 84 Länge/Breite (RFC 7946), 2D',
    noCrs:
      'Keine Messung hier hat ein Koordinatensystem, daher wird die Datei in den Rahmen geschrieben, in denen gemessen ' +
      'wurde, und als nicht georeferenziert markiert.',
    units:
      'Jeder Wert hat seine Einheit daneben. Messungen, deren Raster, Ebene oder Rahmen sich seitdem geändert hat, sind ' +
      'enthalten und als veraltet markiert.',
  },
  poses: {
    orientation: 'Orientierung (Omega, Phi, Kappa)',
    accuracies: 'Genauigkeiten',
    accuraciesImported: 'Genauigkeiten (nur importierte Posen)',
    onlyImported: 'Nur importierte Posen tragen Genauigkeiten',
    coordinates: 'Koordinaten',
    project: 'Projekt-CRS ({crs}), mit Höhen',
    wgs84: 'WGS 84 Länge/Breite (RFC 7946), Höhe als Eigenschaft',
    inCrs: 'Positionen in {crs}.',
    asImported: 'Positionen wie importiert (das Projekt hat kein CRS).',
    metres: 'Positionen in Metern, ohne CRS.',
    oriented: 'Positionen in Modelleinheiten, in Ihrer Orientierung.',
    modelFrame: 'Positionen im Modellrahmen (Modelleinheiten, ohne CRS).',
    readBack: 'Import ▸ Kameraposen liest die Datei als Posen-Vorgaben mit denselben Winkeln wieder ein.',
    imported: 'Die Posen wie importiert, mit ihren Genauigkeiten.',
  },
  sensors: {
    estimated:
      'Brennweite und Bildhauptpunkt, wie die Bündelausgleichung endete, in Pixeln (bei einem Filmscan in seinem ' +
      'Fiducial-Rahmen); das Objektivmodell, mit dem jede Gruppe korrigiert wurde, und alle radialen Terme, die die ' +
      'Selbstkalibrierung darauf angepasst hat (selfcal_k1…k3).',
  },
  matches: {
    content: 'Inhalt',
    matches: 'Jedes Paar mit seinen Matches (Keypoint-Indizes)',
    pairs: 'Nur die Paarliste, mit Match-Anzahlen',
  },
  allmaps: {
    address: 'Bildadresse',
    placeholder: "https://iiif.example.org/iiif/3/'{name}'",
    api: 'IIIF Image API',
    version: 'Version {v}',
    example: '{name} → {uri}',
    photos:
      '{n, plural, one {# ausgerichtetes Foto} other {# ausgerichtete Fotos}}. Die Größe jedes Fotos wird aus seiner ' +
      'info.json auf dem Server gelesen: eine kleinere Kopie geht, eine beschnittene oder gedrehte entfällt.',
    problem: {
      empty: 'Zuerst die IIIF-Adresse der Fotos eingeben',
      notUrl: 'Die IIIF-Adresse muss mit https:// (oder http://) beginnen',
      noPlaceholder: "'{name}' oder '{stem}' in die IIIF-Adresse setzen, damit jedes Foto seine eigene bekommt",
    },
  },
  vectors: {
    coordinates: 'Koordinaten',
    project: 'Projekt-CRS ({crs})',
    wgs84: 'WGS 84 Länge/Breite (RFC 7946)',
    noCrs: 'Das Projekt hat kein CRS, daher wird die Ebene in ihren eigenen Koordinaten geschrieben.',
  },
  run: 'Exportieren',
}
