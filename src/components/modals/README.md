# Dialogs

Every dialog of the app, grouped by where it lives in the UI. The three hosts at the
top level mount them: `ProjectModals.vue` (projects, settings, the workflow builder,
progress), `PipelineModals.vue` (the Reconstruct steps, the model, cloud, mesh and
product tools, and export) and `DataModals.vue` (imports, tables, the image tools and
layer styles). A host reads store state
itself and takes App.vue's handlers from `useAppContext()` (`src/appContext.js`).

| Folder | Dialogs |
| --- | --- |
| `app/` | settings, about, system info, debug summary, model download, and the shared confirm and progress dialogs |
| `project/` | new project, project settings, export a project file, reconnect a folder |
| `import/` | everything under **Import**: images by kind, cameras, GCPs, footprints, fiducials, rasters, clouds, video, SfM projects |
| `inspect/` | the tables under **View ▸ Inspect**: images, sensors, camera poses, control points, matches, masks, image info |
| `images/` | **Tools ▸ Images**: auto mask, image quality, film fiducials, reseau, panoramic strips |
| `pipeline/` | the **Reconstruct** steps: detect, match, sparse, depth maps, dense, and the workflow builder |
| `georef/` | **Reconstruct ▸ Georeferencing**: georeference, find GCPs, scale bars |
| `model/` | **Tools ▸ Model**: optimize cameras, gradual selection, footprints from poses |
| `cloud/` | **Tools ▸ Point Cloud**: filter, crop, transform, merge, align, normals, ground classification, distance, section, symbology |
| `mesh/` | building a mesh, and **Tools ▸ Mesh**: clean, smooth, decimate, sample, texture, measure |
| `products/` | DEM, orthophoto, terrain, contours, clipping, raster styles, and **Export** |
| `eval/` | the Quality Report and its sections |
| `ui/` | the building blocks every dialog uses: `ModalShell`, settings fields, preset cards, tables, warnings |

A new dialog goes in the folder of the ribbon tab or menu that opens it, is built from
`ui/ModalShell.vue`, and is mounted by the host that owns its area.
