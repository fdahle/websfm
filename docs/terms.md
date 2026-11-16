# Words we use

The words WebSfM's interface, help, messages and docs use for the same things, so a
thing has one name wherever a user meets it. Write for people who know photogrammetry
from Metashape, COLMAP or ODM ([CONTRIBUTING.md](../CONTRIBUTING.md) ▸ *Keep the in-app
help in step*).

This is not the glossary: the glossary (`src/glossary/`) explains concepts to users,
and its `aliases` deliberately list the other names, so that help text using them
still links. This list says which name *we* write.

Each entry: the word, what it means in WebSfM, and the words to avoid. A ribbon label
may be a shorter form where space is tight (it says so).

## Photos and cameras

**Sensor**:
A camera definition that many photos share: sensor size, focal length, distortion. One
calibration is solved for all its photos.
_Avoid_: camera model, calibration group

**Calibration**:
A sensor's lens values (focal length, principal point, distortion), as entered or as
bundle adjustment refined them.
_Avoid_: interior orientation (in the glossary only)

**Camera pose**:
Where a camera stood and which way it looked, for one photo. "Camera position" when only
the position is meant.
_Avoid_: exterior orientation (in the glossary only)

**Film scan**:
A scanned frame of aerial film. **Fiducials** are the marks in its frame; **reseau
crosses** the grid exposed onto the film.
_Avoid_: scanned image, fiducial marker

## Features and matching

**Keypoint**:
A distinctive point found in a photo, one word. **Features** are keypoints with their
descriptors (Detect Features).
_Avoid_: key point, feature point, interest point

**Image pair**:
Two photos considered for matching. Its **matches** are keypoint correspondences;
**verified matches** are those that passed the geometric check.
_Avoid_: photo pair, correspondences (in the glossary only)

## The sparse model

**Sparse model**:
What Sparse Model builds: the camera poses, the calibration and the tie points.
_Avoid_: alignment, sparse reconstruction (as a noun for the result)

**Tie point**:
A 3D point of the sparse model, seen in several photos. Together they are the **sparse
cloud**.
_Avoid_: sparse point, sparse point cloud

**Track**:
The keypoints in several photos that belong to one tie point.
_Avoid_: feature track, chain

**Reprojection error**:
The distance in pixels between a keypoint and where its tie point projects.
_Avoid_: reprojection residual (a **residual** is a GCP's or camera position's difference
from its reference coordinates)

**Bundle adjustment**:
The joint refinement of poses, calibration and tie points.
_Avoid_: BA (in the glossary only), optimization (alone)

**Region**:
The box that limits depth maps, fusion, the mesh and the DEM (Tools ▸ Model ▸ Region).
_Avoid_: bounding box, ROI

## Dense and products

**Depth map**:
One photo's estimated depth per pixel; two words, hyphenated only before a noun
("depth-map filter").
_Avoid_: depthmap

**Dense cloud**:
The point cloud fused from the depth maps.
_Avoid_: dense point cloud, dense model

**Mesh**:
A triangulated surface; **textured** once the photos are painted onto it.
_Avoid_: model, surface (for the mesh itself)

**DEM**:
Any elevation raster. **DSM** when it includes buildings and trees, **DTM** for bare
earth, when the difference matters.
_Avoid_: height map, elevation grid

**Orthophoto**:
The photos projected onto a DEM or mesh into one map-accurate image. The ribbon label is
**Ortho**.
_Avoid_: orthomosaic (except for Metashape's product), orthoimage, ortho (in sentences)

## Georeferencing

**GCP**:
A ground control point: a point whose coordinates are known from survey, marked in the
photos. Spell it out once per article. Its role is **control** (it takes part in the fit)
or **checkpoint** (it is left out, and its error measures the accuracy).
_Avoid_: control point (for a GCP of either role)

**Checkpoint**:
A GCP left out of the fit to measure accuracy; one word.
_Avoid_: check point, check-point, validation point

**Scale bar**:
A known distance between two points marked in the photos.
_Avoid_: distance constraint, scale reference

**Georeference**:
The verb (georeference the model); the noun is **georeferencing**.
_Avoid_: geo-reference, geolocate, register (for this step)

**Coordinate system**:
Short for coordinate reference system; write **CRS** after the first use.
_Avoid_: projection, SRS, spatial reference

## The app

**Project**:
One reconstruction, saved in the browser or in a folder; a **.websfm file** is a project
saved as one file.
_Avoid_: workspace, chunk, document

**Run**:
One execution of a processing step, from its dialog's Run button or a workflow.
_Avoid_: job, task, process

**WebSfM**:
The name, in anything people read; `websfm` only in identifiers (URLs, file names, keys).
_Avoid_: Websfm, WebSFM, websfm (in text)

## Not settled yet

These are used both ways today; the choice changes text in the app, so it is open:

- **Dense Model** (Reconstruct ribbon button) against **dense cloud** everywhere else.
- **Key points** (Export ribbon button) against **keypoints** everywhere else.
- **Camera Groups** (a guide article's title) against **Sensors** (View ▸ Inspect and the
  glossary).
- **Intrinsics** and **Extrinsics** (the Image Table's tabs, and some guide articles)
  against **calibration** and **camera pose**.
- **Photo** against **image**: both are common, often in one sentence.
- **Marker**: a GCP in the Control & Markers table and Metashape's word, but also any
  detected target or tag that no GCP is named after yet.
