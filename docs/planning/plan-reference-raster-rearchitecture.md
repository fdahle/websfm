# Remaining reference-raster work

Local display is implemented (2026-09-27): original Blob storage, fast ortho
preview, serialized background tiled COG conversion, OPFS COG sidecars, WebGLTile
map layers and square-pixel raster tabs, GPU gray/RGB/index styles, and bounded
raw-value windows. Chrome integration covers EPSG:3031, six uint16 bands,
RGB/index restyles and unchanged raw values. GCP candidate review is operational.
The converter retains one source's decoded blocks under an estimated 512 MiB
budget, compresses output tiles individually, and assembles Blob parts without a
second full-image output buffer. Already tiled files with overviews are reused.

Open implementation:

- Replace full imported-DEM elevation planes with windowed sampling/profile/diff
  consumers; keep nodata, vertical datum and accuracy semantics unchanged.
- Extend conversion to sources beyond the decoding budget. A giant source strip
  can itself exceed the budget, so output tiling alone cannot bound its decoder.
- Support rectangular-pixel tiled product tabs while keeping measurement pixel
  transforms exact. Map layers already draw them in native coordinates.
- Remote COG sources and storage/cache management UI.

Manual evidence remains in VERIFICATION.csv: RAS-06 for large real raster import,
conversion, first-draw and restyle timings; UX-GCP-01 for historical imagery.
The current hybrid retains flat DEM analysis and preview fallback, so deleting
those paths before their consumers migrate would lose functionality.
