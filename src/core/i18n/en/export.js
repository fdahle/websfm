// Every Export ▸ … dialog (components/modals/products/ExportModal.vue): one per kind of
// export, with its formats as cards (`label`, `blurb` under it, `hint` for the step's
// line when the format needs more than its blurb), the kind's own settings and the file.
export default {
  title: {
    cloud: 'Export Point Cloud',
    mesh: 'Export Mesh',
    model: 'Export Model',
    colmap: 'Export SfM Project',
    tiles3d: 'Export 3D Tiles',
    undistorted: 'Export Undistorted Images',
    dem: 'Export DEM',
    measurements: 'Export Measurements',
    ortho: 'Export Orthophoto',
    poses: 'Export Camera Poses',
    sensors: 'Export Calibration',
    cameraFiducials: 'Export Camera Fiducials',
    imageFiducials: 'Export Image Fiducials',
    keypoints: 'Export Keypoints',
    matches: 'Export Matches',
    vectors: 'Export Vector Layer',
    footprints: 'Export Footprints',
    allmaps: 'Export to Allmaps',
  },
  // The Format step's line for a kind whose formats need one, when the format has none.
  hint: {
    colmap:
      'Exchange a complete COLMAP workspace, its feature database, a sparse model, or camera transforms for NeRF / ' +
      'Gaussian-Splatting tools. Unsupported descriptor encodings are omitted while keypoints and verified matches ' +
      'are retained.',
    tiles3d:
      'For globe viewers (Cesium, and anything else reading 3D Tiles 1.1). The model is placed by a transform ' +
      'measured from the project CRS, so it lands correctly even at polar latitudes.',
    undistorted:
      "Pinhole images + a PINHOLE sparse model, the handoff COLMAP's image_undistorter produces (for OpenMVS, MVE " +
      'and MVS-Texturing), and a transforms.json for NeRF / 3D Gaussian Splatting tools. Lens distortion and ' +
      'film-scan geometry are already folded out of the model, so only the pixels are resampled.',
    sensors: 'Import ▸ Calibration reads it back: one row per camera group, or per image.',
    cameraFiducials:
      "Each film camera's calibrated marks in millimetres, one row per mark. Import ▸ Camera Fiducials reads it back.",
    imageFiducials:
      "Each scan's detected or marked fiducials in pixels, one row per mark. Import ▸ Image Fiducials reads it back.",
    matches: 'The pairs whose matches passed geometric verification; a rejected pair has none to list.',
    allmaps:
      'One Georeference Annotation per aligned photo, in one file. Open it in Allmaps Viewer (paste it in, or give it ' +
      'its address): each photo is loaded from your IIIF image server and warped onto the map by its control points, ' +
      'which follow the ground and the lens as Photos on the 2D map does.',
  },
  // The formats, by kind and format id.
  format: {
    cloud: {
      'ply-binary': { label: 'PLY', blurb: 'binary (compact)' },
      'ply-ascii': { label: 'PLY', blurb: 'ASCII (text)' },
      'las': { label: 'LAS 1.2', blurb: 'surveying standard' },
      'laz': { label: 'LAZ', blurb: 'compressed LAS (5–10× smaller)' },
      'copc': {
        label: 'COPC',
        blurb: 'cloud-optimized LAZ (streams in QGIS, Potree)',
        hint:
          'LAZ 1.4 stored as a level-of-detail octree: QGIS, Potree, PDAL and WebSfM read the part they show, so a ' +
          'large cloud opens at once.',
      },
      'xyz': { label: 'XYZ', blurb: 'plain text (x y z r g b)' },
    },
    mesh: {
      'ply-binary': { label: 'PLY', blurb: 'binary (faces)' },
      'ply-ascii': { label: 'PLY', blurb: 'ASCII (text)' },
      'glb': { label: 'glTF binary', blurb: '.glb' },
      'obj': { label: 'Wavefront OBJ', blurb: '.obj' },
      'stl': { label: 'STL', blurb: 'binary (no colour)' },
    },
    model: {
      json: { label: 'JSON', blurb: 'cameras + tracks' },
      transforms: {
        label: 'transforms.json',
        blurb: 'NeRF / 3DGS',
        hint:
          'Camera-to-world poses (OpenGL convention) + intrinsics for nerfstudio, instant-ngp and 3D Gaussian ' +
          'Splatting. Local SfM frame; pinhole.',
      },
    },
    colmap: {
      workspace: { label: 'COLMAP workspace', blurb: 'database + sparse model' },
      database: { label: 'COLMAP database.db', blurb: 'cameras + features + matches' },
      txt: { label: 'Text (.txt)', blurb: 'zipped' },
      bin: { label: 'Binary (.bin)', blurb: 'zipped' },
      transforms: { label: 'transforms.json', blurb: 'NeRF / 3DGS' },
      openmvg: { label: 'OpenMVG sfm_data.json' },
      nvm: { label: 'VisualSFM NVM v3' },
      metashape: {
        label: 'Metashape XML',
        blurb: 'cameras, calibration, markers',
        hint:
          'In Agisoft Metashape, read it with Import Cameras (File menu), then Import Markers: the registered ' +
          'cameras with their calibration, and the GCPs with their marks. In WGS 84 when the project is georeferenced.',
      },
    },
    tiles3d: {
      tileset: { label: 'Cesium 3D Tiles 1.1', blurb: 'tileset.json + glTF tiles (.zip)' },
    },
    undistorted: {
      jpeg: { label: 'JPEG', blurb: 'compact (recommended for MVS)' },
      png: { label: 'PNG', blurb: 'lossless (much larger)' },
    },
    dem: {
      geotiff: { label: 'GeoTIFF (.tif)', blurb: 'georeferenced' },
      cog: {
        label: 'Cloud-Optimized GeoTIFF',
        blurb: 'tiled + overviews',
        hint:
          'Internally tiled with halving overviews, so a viewer can fetch a preview or one window with a few range ' +
          'requests instead of the whole file. Readable anywhere a normal GeoTIFF is.',
      },
      asc: { label: 'ESRI ASCII grid', blurb: '.asc' },
      png: { label: 'Hillshade PNG + world file' },
      support: { label: 'Support layer GeoTIFF (.tif)', blurb: '% of each cell measured' },
    },
    measurements: {
      csv: { label: 'CSV', blurb: 'one row per measurement, units in columns' },
      geojson: { label: 'GeoJSON', blurb: 'lines and polygons with their values' },
    },
    ortho: {
      geotiff: { label: 'GeoTIFF (.tif)', blurb: 'georeferenced' },
      cog: {
        label: 'Cloud-Optimized GeoTIFF',
        blurb: 'tiled + overviews',
        hint:
          'Internally tiled with halving overviews and DEFLATE compression: the orthophoto exactly as it is stored, ' +
          'for web/GIS delivery. Readable anywhere a normal GeoTIFF is.',
      },
      png: { label: 'PNG + world file', blurb: '.wld' },
      jpeg: { label: 'JPEG + world file' },
      mbtiles: {
        label: 'MBTiles',
        blurb: 'web map tiles (QGIS, QField, MapLibre)',
        hint:
          'Web Mercator tiles in one file, from the zoom that shows the whole area to the one as fine as the ' +
          'orthophoto: for an offline field map or a web map.',
      },
      xyz: {
        label: 'XYZ tiles (.zip)',
        blurb: "'{z}/{x}/{y}' folders",
        hint: 'The same tiles as loose files, for a web server or a static web map.',
      },
    },
    poses: {
      csv: { label: 'CSV', blurb: 'one row per camera' },
      txt: { label: 'Text (.txt)', blurb: 'tab-separated' },
      geojson: { label: 'GeoJSON', blurb: 'one point per camera, for GIS' },
    },
    sensors: {
      csv: { label: 'CSV' },
      txt: { label: 'Text (.txt)', blurb: 'tab-separated' },
    },
    cameraFiducials: {
      csv: { label: 'CSV' },
      txt: { label: 'Text (.txt)', blurb: 'tab-separated' },
    },
    imageFiducials: {
      csv: { label: 'CSV' },
      txt: { label: 'Text (.txt)', blurb: 'tab-separated' },
    },
    keypoints: {
      json: {
        label: 'JSON',
        blurb: 'one entry per image',
        hint: 'Position (pixels), scale and response of each keypoint.',
      },
      csv: {
        label: 'CSV',
        blurb: 'one row per keypoint',
        hint: 'image, x, y, scale, response: one row per keypoint, for a spreadsheet or pandas.',
      },
    },
    matches: {
      json: { label: 'JSON', blurb: 'one entry per pair' },
      csv: { label: 'CSV', blurb: 'one row per match' },
    },
    vectors: {
      geojson: { label: 'GeoJSON', blurb: '.geojson' },
      kml: { label: 'KML (.kml)', blurb: 'Google Earth, WGS 84' },
    },
    allmaps: {
      annotations: { label: 'Georeference Annotations', blurb: 'IIIF JSON for Allmaps' },
    },
  },
  // A format offered greyed, with why.
  unavailable: {
    needsCrs: 'needs a project CRS',
    tooLarge: 'too large (at most {side, number}² px); use a GeoTIFF',
  },
  // Apply the model's frame to what is written (point cloud, mesh, estimated poses).
  frame: {
    georef: 'Georeference (transform into the project CRS)',
    scaleOrient: 'Apply scale and orientation (metres, levelled — no CRS is attached)',
    scale: 'Apply scale (write metres — no CRS is attached)',
    orient: 'Apply orientation (levelled, with your origin and heading — model units)',
  },
  step: {
    format: 'Format',
    file: 'File',
    crs: 'Coordinate system',
    // The kind's own settings.
    options: {
      allmaps: 'IIIF images',
      tiles3d: 'Tiles',
      undistorted: 'Images',
      dem: 'Cells',
      ortho: 'Pixels',
      measurements: 'Coordinates',
      vectors: 'Coordinates',
      other: 'Content',
    },
  },
  exporting: 'Exporting <strong>{name}</strong>',
  source: {
    label: 'Source',
    cloud:
      '{name} · {kind, select, dense {dense cloud} sparse {sparse model} other {point cloud}}, ' +
      '{n, plural, one {# point} other {# points}}{main, select, yes { · main} other {}}',
    mesh:
      '{name} · {n, plural, one {# triangle} other {# triangles}}{textured, select, yes {, textured} other {}}' +
      '{main, select, yes { · main} other {}}',
    raster: '{name}{main, select, yes { · main} other {}}',
    noSparse: 'Build a sparse model first (Reconstruct ▸ Sparse Model)',
    posesEstimated: 'Estimated by the reconstruction ({n, plural, one {# camera} other {# cameras}})',
    posesImported: 'Imported poses ({n, plural, one {# pose} other {# poses}})',
    noImportedPoses: 'No camera poses imported (Import ▸ Camera Poses)',
    sensorsEstimated: 'Estimated by the reconstruction, one row per camera group',
    sensorsEstimatedPerImage:
      'Estimated by the reconstruction, one row per image ({n, plural, one {# camera} other {# cameras}})',
    sensorsEntered: 'As entered ({n, plural, one {# camera group} other {# camera groups}})',
    noEnteredCalibration: 'No camera group has a calibration entered',
  },
  supportLayer: {
    label: 'Support layer',
    effect:
      ': for each DEM cell, the percentage that points landed in (0 = filled by interpolation), 255 where the DEM is ' +
      "empty. On the DEM's grid, or its overview for a DEM too large for one plane.",
  },
  cloud: {
    colours: 'Include vertex colours',
    lasColours: 'Include vertex colours (LAS always stores RGB when the cloud has colour)',
    lasAlwaysRgb: 'LAS always stores RGB when the cloud has colour',
    voxel: {
      label: 'Voxel downsample cell',
      hint: 'World units; 0 = keep every point.',
      hintGeoref: 'World units (project CRS when georeferenced); 0 = keep every point.',
      hintScaled: 'World units (metres when scaled); 0 = keep every point.',
    },
    attributes:
      'Point attributes (a computed distance, imported intensity or classification) are written to PLY and LAS. LAZ ' +
      'keeps only the standard LAS fields; XYZ keeps none.',
  },
  mesh: {
    texture: 'Include the photo texture',
    textureOnly: 'Include the photo texture (GLB or OBJ only)',
    textureFormats: 'Only GLB and OBJ carry a texture',
    glbTexture: 'The atlas pages are embedded in the .glb.',
    objTexture: 'Downloads a .zip with the .obj, its .mtl and one JPEG per atlas page.',
    colours: 'Include vertex colours',
    stlColours: 'Include vertex colours (STL has no colour)',
    stlNoColour: 'STL has no colour',
  },
  model: { tracks: 'Include point tracks (image observations)' },
  colmap: { images: 'Include original source images (larger ZIP)' },
  tiles3d: {
    tiling: 'Tiling',
    lod: 'Level of detail (hierarchy of tiles)',
    single: 'Single tile',
    singleTooLarge: 'Single tile — too large for one tile',
    tooLarge: 'Too large for one tile',
    lodMesh: 'The mesh split into tiles and decimated per level; viewers load detail where the camera is.',
    lodCloud: "One tile per node of the cloud's level-of-detail octree; viewers load detail where the camera is.",
    singleHint: 'The whole model in one tile, loaded at once.',
    triangles: 'Triangles per tile',
    textureLod: 'The finest tiles keep the photo texture; the coarser, decimated ones have vertex colours.',
    textureSingle: 'The tile is the selected textured mesh, with its photo texture.',
    colours: 'Include vertex colours',
    streamed:
      'A streamed cloud is written in its own coordinates and placed in the CRS its file names, else the project CRS.',
    noGeoref:
      'This project has no georeference, so the tileset will have no position on the globe. Georeference the model ' +
      'first.',
  },
  undistorted: {
    border: 'Border',
    borderHint: 'Cropping keeps only the region that samples inside the source image.',
    crop: 'Crop to the valid region',
    full: 'Keep the full frame (blank borders)',
    quality: 'JPEG quality: {q, number, ::.00}',
    maxDim: 'Maximum dimension',
    maxDimHint: 'Longest output side in pixels; 0 = native resolution. Lower it for a smaller ZIP.',
  },
  raster: {
    nodata: 'NODATA value',
    nodataHint: 'Written for empty cells (holes with no measurement).',
    compression: 'Compression',
    none: 'None (uncompressed)',
    deflate: 'DEFLATE (lossless)',
    alpha: 'Alpha band (transparent empty pixels)',
    tileFormat: 'Tile format',
    tilePng: 'PNG — transparent edges',
    tileJpeg: 'JPEG — smaller, white edges',
    tileWebp: 'WebP — small, transparent (newer viewers)',
    jpegQuality: 'JPEG quality: {q, number, ::.00}',
    tileQuality: 'Tile quality: {q, number, ::.00}',
    crs: 'Coordinate system',
    crsHint: 'Another CRS writes a reprojected copy; the product itself stays as built.',
    localHint: 'A raster in the local frame has no CRS to reproject from.',
    asBuilt: 'As built ({crs})',
    localFrame: 'local frame, no CRS',
    anotherCrs: 'Another CRS…',
    resampling: 'Resampling',
    bilinear: 'Bilinear',
    nearest: 'Nearest',
    resamplingDem: 'Bilinear interpolates heights; Nearest keeps every value as measured.',
    resamplingOrtho: 'Bilinear is smoother; Nearest keeps every pixel as it was.',
    reprojectedDem:
      'Written as a Cloud-Optimized GeoTIFF (DEFLATE, nodata NaN) at the same ground cell size. Heights keep their ' +
      'vertical datum: only the horizontal CRS changes.',
    reprojectedOrtho: 'Written as a Cloud-Optimized GeoTIFF (DEFLATE) at the same ground cell size.',
  },
  measurements: {
    coordinates: 'Coordinates',
    project: 'Project CRS ({crs}), heights kept',
    wgs84: 'WGS 84 longitude/latitude (RFC 7946), 2D',
    noCrs:
      'No measurement here has a coordinate system, so the file is written in the frames they were measured in and ' +
      'marked as not georeferenced.',
    units:
      'Every value has its unit beside it. Measurements whose raster, layer or frame has changed since are included ' +
      'and marked stale.',
  },
  poses: {
    orientation: 'Orientation (omega, phi, kappa)',
    accuracies: 'Accuracies',
    accuraciesImported: 'Accuracies (imported poses only)',
    onlyImported: 'Only imported poses carry accuracies',
    coordinates: 'Coordinates',
    project: 'Project CRS ({crs}), heights kept',
    wgs84: 'WGS 84 longitude/latitude (RFC 7946), height as a property',
    inCrs: 'Positions in {crs}.',
    asImported: 'Positions as imported (the project has no CRS).',
    metres: 'Positions in metres, no CRS.',
    oriented: 'Positions in model units, in your orientation.',
    modelFrame: 'Positions in the model frame (model units, no CRS).',
    readBack: 'Import ▸ Camera Poses reads the file back as pose priors with the same angles.',
    imported: 'The poses as imported, with their accuracies.',
  },
  sensors: {
    estimated:
      "Focal length and principal point as bundle adjustment ended, in pixels (a film scan's in its fiducial frame); " +
      'the lens model each group was corrected with, and any radial terms self-calibration fitted on top of it ' +
      '(selfcal_k1…k3).',
  },
  matches: {
    content: 'Content',
    matches: 'Every pair with its matches (keypoint indices)',
    pairs: 'The pair list only, with match counts',
  },
  allmaps: {
    address: 'Image address',
    placeholder: "https://iiif.example.org/iiif/3/'{name}'",
    api: 'IIIF Image API',
    version: 'Version {v}',
    example: '{name} → {uri}',
    photos:
      '{n, plural, one {# aligned photo} other {# aligned photos}}. Each photo’s size is read from its info.json on ' +
      'the server: a smaller copy is fine, a cropped or turned one is left out.',
    problem: {
      empty: 'Type the IIIF address of the photos first',
      notUrl: 'The IIIF address must start with https:// (or http://)',
      noPlaceholder: "Put '{name}' or '{stem}' in the IIIF address, so each photo gets its own",
    },
  },
  vectors: {
    coordinates: 'Coordinates',
    project: 'Project CRS ({crs})',
    wgs84: 'WGS 84 longitude/latitude (RFC 7946)',
    noCrs: 'The project has no CRS, so the layer is written in its own coordinates.',
  },
  run: 'Export',
}
