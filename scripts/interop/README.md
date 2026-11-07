# Interop check

Do the tools people open WebSfM's exports in read them as WebSfM wrote them?

```bash
npm run check:interop            # Docker for GDAL, PDAL and COLMAP
COLMAP_BIN=colmap npm run check:interop   # a local COLMAP instead of its image
```

`make-exports.mjs` writes known synthetic data through the same functions the app's
Export menu calls, and `expected.json` with what each file must contain. `check.mjs`
then has the other tools read the files:

| Export | Tool | What must hold |
| --- | --- | --- |
| DEM COG, DEM GeoTIFF, the stored DEM product (COG builder), ortho GeoTIFF | GDAL (`check_gdal.py`) | GDAL's COG validator with its full check passes; EPSG, geotransform, nodata, values at known cells, the hole is nodata, the ortho's 4th band is alpha |
| LAS, LAZ, COPC | PDAL (`readers.las`, and `readers.copc` for the COPC) | point count in the header and decoded, bounds, EPSG, classes, 16-bit colour |
| COLMAP text and binary model | COLMAP `bundle_adjuster` | it reads every observation, and its own reprojection of our points into our cameras is ~0 px (a flipped rotation gives 21 px) |

CI runs it in the `interop` job (.github/workflows/verify.yml) with COLMAP 3.9 from
Ubuntu's packages; locally it ran with COLMAP 4.0. GDAL and PDAL images are pinned in
`check.mjs`.

Not covered yet: meshes (OBJ / PLY / GLB in Blender or MeshLab), 3D Tiles (Cesium's
validator), the COLMAP database, Metashape XML.
