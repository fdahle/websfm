# PLAN — separate fiducial detection from fiducial calibration

Status: implemented 2026-07-20; representative real-scan browser acceptance is
still owed. This file is retained as the implementation/acceptance record. The
anonymous detection model, separate calibration task, persistence migration and
reconstruction adapter are shipped and covered by automated tests.

## Goal

Make the two domain operations genuinely independent:

- **Detect Fiducials** finds and reviews visible image structures. It requires
  film images plus a detector type/position prior. It must not require mark IDs,
  millimetre coordinates, focal length, principal point, or a marked reference.
- **Calibrate Fiducials** assigns the detected structures to a camera coordinate
  system and estimates/imports the metric layout used for interior orientation.
  It is a separate button, modal, store action, method, and validation report.

The target user flow is:

```text
set sensor to Film
  → Detect Fiducials…
      choose Generic / Right angle / 45° cut / Frame
      choose Corners / Sides / Corners + sides
      detect anonymous spots on selected images
      review only uncertain spots
  → Calibrate Fiducials…
      import certificate OR estimate layout from selected scans
      confirm one orientation/identity mapping
      choose transform model
      inspect residuals and apply
  → reconstruction uses calibrated detections
```

This follows Metashape's useful separation. Its Detect Fiducials task exposes
Generic, Right angle, 45-degree/V-shape and Frame detectors, corner/side search,
and optional background-mask generation. Certificate coordinates are entered
after automatic detection; when no certificate layout exists, Calibrate
Fiducials uses the selected calibration group and a declared scan resolution.

## Hard invariants

1. Detection never reads `sensor.fiducials.marks`, focal length, principal point,
   or any calibration transform.
2. A detected pixel is not a calibrated observation. Names and storage must keep
   that distinction visible.
3. Detection may use only image evidence, film-frame geometry, positional class
   (corners/sides), detector family, and cross-image batch consensus.
4. Calibration never changes detected pixel centres. It maps slots/identities and
   estimates metric parameters; corrections to a centre go through Review
   Detections.
5. Reconstruction receives calibrated pairs through one adapter and refuses an
   uncalibrated film sensor with a clear message.
6. Symmetric identical marks cannot reveal camera orientation. Detection assigns
   raster-relative slots; calibration asks for one orientation confirmation (and
   a second anchor only if reflection remains possible). Never guess.
7. Automatic writes remain buffered. Failed or ambiguous detections are drafts;
   a wrong accepted centre is more harmful than a missing one.

## Scope and non-goals

In scope:

- Metashape-like family and position choices;
- fully anonymous detection before calibration;
- persisted accepted detections and ephemeral/reviewable drafts;
- automatic template learning from high-confidence detections;
- certificate and batch-estimated calibration modes;
- Conformal/similarity, Affine and Projective scan transforms;
- separate ribbon and sensor-table buttons;
- migration of existing projects and imported fiducial observations.

Out of scope:

- inferring camera focal length from fiducials alone;
- promising metric camera calibration without a certificate or known scan pitch;
- training a neural detector before the classical benchmark exists;
- silently treating frame corners as precise physical fiducials (Frame mode must
  carry its lower accuracy into calibration/reporting).

## New domain model

Replace the overloaded “fiducial observation” concept with three layers.

### Image detections (image-space evidence)

Persist on each image:

```js
image.fiducialDetections = [{
  slot: 'corner-tl',             // raster-relative stable slot
  px: 123.45,
  py: 678.90,
  family: 'generic',
  source: 'shape' | 'template' | 'manual' | 'frame',
  confidence: 0.94,
  reviewed: false,
}]
```

Canonical slots:

- corners: `corner-tl`, `corner-tr`, `corner-br`, `corner-bl`;
- sides: `side-top`, `side-right`, `side-bottom`, `side-left`;
- corners+sides: all eight;
- custom/manual designs: stable `custom-1…N`, ordered clockwise after the user
  establishes the first slot.

Slots describe the displayed raster only. Rotating a scan changes which physical
camera mark occupies a slot; calibration owns that mapping.

Do not persist raw rejected candidates. A detection run returns drafts with full
diagnostics; only accepted/reviewed centres enter `fiducialDetections`.

### Sensor calibration (camera-space interpretation)

Persist separately:

```js
sensor.fiducialCalibration = {
  version: 1,
  method: 'certificate' | 'batch',
  transform: 'conformal' | 'affine' | 'projective',
  allowReflection: false,
  slotMap: { 'corner-tl': 'F1', 'corner-tr': 'F2', ... },
  marks: [{ id: 'F1', xMm: -106.0, yMm: -106.0 }, ...],
  focalMm: 153.87,
  ppxMm: 0.011,
  ppyMm: -0.004,
  scanPitchMm: 0.014,            // required/estimated in batch mode
  fit: { imageCount, rmsUm, p95Um, calibratedAt },
}
```

Detection preferences such as family/positions are not calibration. Store the
last-used detection settings separately (UI preference or
`sensor.fiducialDetectionHint`) and version them.

### Reconstruction adapter

Add one pure function:

```js
calibratedFiducialPairs(image, sensor)
  → [{ slot, fidId, px, py, xMm, yMm }]
```

Every interior-orientation consumer calls this adapter. Nothing outside it joins
image detections to calibration marks.

### Migration

On restore, migrate legacy `image.fiducialObs[{fidId,px,py}]` plus
`sensor.fiducials.marks`:

- derive raster-relative slots from each image's detected positions (clockwise,
  corner/side classification against its film bounds);
- create `fiducialDetections` with `source:'manual'`, `confidence:1`,
  `reviewed:true`;
- create `fiducialCalibration` from the old metric fields and slot-to-`fidId`
  relationship;
- retain a versioned compatibility read for one release, but write only the new
  schema;
- if slot inference is ambiguous, preserve the legacy data in a migration report
  and require orientation confirmation rather than changing identities silently.

## Step 0 — benchmark corpus and removal boundary

Before changing detector thresholds, add a local/fixture benchmark manifest with
ground-truth anonymous centres and slots. Cover all intended families, positive
and negative scans, 4/8 marks, frame annotations, scratches, uneven borders,
rotations, scan-size changes, blur, clipping and weak contrast. Private images may
live outside git; commit synthetic and licensed crops.

Add `scripts/benchmark-fiducial-detection.mjs` reporting detection-only metrics:

- spot precision/recall independent of camera IDs;
- correct raster-slot rate;
- centre-error median/p95;
- accepted/draft/missed counts;
- family and position breakdown;
- decode, coarse, refinement and template-retry time.

Release targets on representative real data:

- no accepted false spots;
- ≥95% image-level complete detection for supported designs;
- median centre error ≤0.5 px, p95 ≤1.5 px;
- every miss/ambiguous peak remains a draft;
- batch runtime remains practical for 100 MP TIFF-derived compute PNGs.

Quarantine the current `fiducialBootstrap.js` path behind a legacy flag while the
new detector is developed. Delete it only after side-by-side acceptance; do not
incrementally mutate layout-dependent bootstrap into anonymous detection.

## Step 1 — detection-only pure core

Create `src/core/sfm/fiducialDetection.js`. It must not import `fiducials.js` or
accept calibrated marks.

Inputs:

```js
detectFiducialSpots(gray, width, height, {
  family,                    // generic | right-angle | cut-45 | frame
  positions,                 // corners | sides | corners+sides
  polarity,                  // auto | dark | light
  tolerance,
})
```

Pipeline:

1. **Film-frame estimation** — robust row/column profiles plus edge/line fitting;
   return four lines, corners, polarity and confidence. Do not assume a fixed 2.5%
   inset. Handle asymmetric scanner borders and modest skew.
2. **Search-region construction** — build corner or side-midpoint bands from the
   measured frame. Regions are raster-relative and therefore require no metric
   layout.
3. **Family candidates** — multi-scale generated prototypes/structural responses:
   radial/blob + line intersection for Generic; perpendicular arms for Right
   angle; diagonal cut + circle/V response for 45°; measured line intersection or
   side midpoint for Frame.
4. **Candidate NMS** — retain several spatially distinct peaks per slot and expose
   best/second-best margin.
5. **Native-centre refinement** — family-specific fit in an injected full-resolution
   crop with sub-pixel peak and sharpness/covariance.
6. **Topology validation** — one centre per requested slot, clockwise order,
   closeness to its frame region, no duplicate centre, and dimensionless fit to a
   consensus rectangle/octagon. This is detection QC, not metric calibration.

Return `{ accepted, drafts, frame, diagnostics }`. Each accepted item is an
anonymous slot record; drafts include reason codes such as `weak-peak`,
`two-peaks`, `frame-uncertain`, `missing-slot`, or `topology-conflict`.

Pure tests: all families/positions/polarities; skewed/asymmetric frame; rotations;
missing/duplicate/false spots; scratches and text near borders; flat image; clipped
mark; contrast inversion; slot order; no calibration object anywhere in fixtures;
sub-pixel recovery; never accept a nominal Frame point when frame confidence is
weak.

## Step 2 — batch consensus and automatic template learning

Detection should improve across a calibration group without requiring a reference.
Add pure batch functions next to the detector:

1. normalize each accepted centre into its measured frame coordinates;
2. compute robust per-slot median position/scale/appearance and MAD;
3. select 3–5 diverse high-confidence donor crops per slot;
4. align polarity/orientation/centre and form a median real-image template;
5. retry only missing/draft slots using the consensus location and learned template;
6. re-run detection QC; do not use calibration RMS or millimetre coordinates.

Unlike the current single strongest donor, require multiple donors when available.
One donor may create drafts but cannot promote an otherwise ambiguous batch to
accepted automatically.

Add worker ops in `workers/ops/detect.js`:

- `detectFiducialSpots(url, settings)`;
- `extractFiducialDonors(url, accepted, settings)`;
- `retryFiducialSpots(url, templateBank, consensus, settings)`.

Reuse lossless `computeUrl`, `ImageBitmap`, thumbnail rasterization and native
source-rect crops. Reusable template buffers are cloned, never transferred.

## Step 3 — detection persistence and review

Refactor `useImagesStore`:

- `detectFiducialsForSensor({sensorId, imageIds, settings, overwrite, ...})` owns
  detection only;
- buffer the complete run, run batch consensus, then persist accepted spots with
  one `sync()`;
- existing detections are preserved unless overwrite is explicit;
- drafts stay in the modal/session until reviewed or discarded;
- expose `setFiducialDetection`, `removeFiducialDetection`,
  `acceptFiducialDraft`, and `clearFiducialDetections`;
- delete calibration imports and affine gates from the detection action.

Import/export gains a detection format with image, slot, px, py and optional
confidence/source. The existing calibrated observation import routes through a
compatibility mapper and requests a slot mapping if needed.

## Step 4 — Metashape-like Detect Fiducials modal

Rebuild `FiducialDetectModal.vue` around detection rather than calibration.

Required controls:

- sensor/calibration group and selected/all images;
- Detection type: **Generic / Right angle / 45° cut / Frame**;
- Fiducial positions: **Corners / Sides / Corners + sides**;
- polarity Auto/Dark/Light and a plain-language tolerance control;
- **Generate background masks** and **Mask dark pixels** options, sharing the
  frame result with the mask system rather than detecting it twice;
- keep existing detections / overwrite;
- progress and cancellation.

There must be no reference-image selector, certificate table, focal field,
principal point field, scan orientation, calibrated-mark count warning, affine
RMS setting, or calibration gate in this modal.

Results show per image: found/requested slots, accepted/drafts, mean confidence,
frame confidence and review action. A crop-based review strip presents only draft
slots with Accept / Adjust / Reject. `Open image` enters a detection-review mode in
`ViewerImage.vue`: anonymous slot labels, proposed-vs-accepted styling, next-draft
navigation, local snap only to image evidence, and automatic advance to the next
image. Cancel discards drafts.

Ribbon and sensor table expose **Detect Fiducials** for every film sensor with at
least one ready image. Disabled reasons mention image readiness only.

## Step 5 — calibration core

Create `src/core/sfm/fiducialCalibration.js`, separate from detection.

### Certificate mode

- parse/paste/import `{id,xMm,yMm}` plus focal/principal point;
- map raster slots to certificate IDs through explicit orientation (0/90/180/270)
  and optional reflection; provide a visual slot diagram;
- fit every selected image using the chosen transform model;
- robustly report per-image and batch residuals; never alter centres;
- require sufficient geometry: conformal/similarity ≥2 non-coincident marks,
  affine ≥3 non-collinear, projective ≥4 with no degenerate configuration;
- apply only when mapping is unique and residual gates pass.

### Batch-estimated mode (no certificate layout)

- require accepted detections on a selected image group and declared scan pitch
  in mm/px;
- establish raster-slot orientation once;
- jointly estimate a consensus centred mark layout plus one per-image transform,
  using robust alternating refinement and a fixed gauge (centroid at zero,
  declared pitch fixes scale, chosen orientation fixes handedness);
- report slot scatter and leave-one-image-out stability;
- clearly label the result **batch-estimated**, not factory calibration;
- focal length and principal point remain separate required camera inputs before
  metric reconstruction. Do not claim fiducials can infer focal length.

### Transform models

Generalize the current affine-only functions behind a common interface:

```js
fitFiducialTransform(pairs, model)
scanToCamera(point, transform)
cameraToScan(point, transform)
```

Implement and test conformal/similarity, affine and projective models, including
inverse, degeneracy, robust residuals and round trips. Update sparse keypoints,
GCP observations, display residuals, dense raster/mask sampling and summary
persistence together. The run summary records model + exact transform per image;
dense never re-fits.

## Step 6 — separate Calibrate Fiducials modal and button

Add `FiducialCalibrateModal.vue` and independent modal-store state.

Entry points:

- Ribbon Tools: **Detect Fiducials** and **Calibrate Fiducials** as separate
  commands/buttons;
- each film-sensor row: two adjacent actions;
- command console: `detect-fiducials` and `calibrate-fiducials`.

The calibration modal opens for any film sensor. If detections are missing it
links to Detect Fiducials rather than disabling itself.

Layout:

1. source cards: **Camera certificate** / **Estimate from scans**;
2. detected-slot coverage summary and image selection;
3. slot diagram with orientation/reflection mapping;
4. transform type: Conformal / Affine / Projective;
5. certificate table or scan-pitch input;
6. focal/principal point fields, explicitly labelled as camera calibration;
7. residual table/plot and failed-image reasons;
8. Apply Calibration.

Calibration status is visible in the sensor table and image sidebar separately
from detection coverage: e.g. `8/8 detected · calibrated` or
`8/8 detected · not calibrated`.

## Step 7 — reconstruction, viewer and safety gates

- Reconstruction calls `calibratedFiducialPairs`; detections without calibration
  remain visible but do not affect SfM.
- Preconditions distinguish “fiducials not detected,” “detections incomplete,”
  and “detections not calibrated.”
- The viewer always shows anonymous detections when enabled. Once calibrated,
  labels may additionally show the mapped certificate ID and metric residual.
- Manual editing operates on the anonymous slot. Changing calibration mapping
  updates every image immediately without rewriting pixel observations.
- Calibration invalidation is explicit: changing/deleting detections marks fit
  diagnostics stale but does not silently delete the calibration definition;
  reconstruction requires a fresh validation stamp.
- Frame-mode calibration carries an accuracy warning and cannot masquerade as
  survey-grade physical fiducials.

## Step 8 — verification and rollout

Per step: `npm test`, `npm run typecheck`, `npm run build`. No Rust/WASM change is
expected. Add store tests for one-sync buffering, overwrite protection, draft
cancel, migration and calibration invalidation. Add worker contract tests where
possible; browser-only canvas flows need real manual acceptance.

Browser acceptance matrix:

- all four detector families × corners/sides/both where meaningful;
- detection works with zero calibrated marks and zero focal/principal-point data;
- certificate coordinates can be entered only after detection and map without
  moving centres;
- symmetric layouts request one orientation confirmation;
- batch calibration with known pitch is reproducible under image selection and
  reports held-out stability;
- legacy projects migrate without changing reconstructed pixel-to-mm pairs;
- cancellation and failures write nothing;
- optional masks share the exact detected frame;
- sparse/dense round trip for all three transform models.

Ship detection first behind a side-by-side legacy toggle only if its data model and
review UI are complete. Do not expose the new calibration button until
reconstruction/dense consume the common transform interface. Remove the legacy
path, its reference-image wording and `PLAN` only after two real camera batches
meet the benchmark and a restored old project reconstructs equivalently.

## Documentation when shipped

- `CLAUDE.md`: separate detection/calibration modules, schemas, stores, worker ops
  and transform invariants.
- `METHODS.md` §5.1: anonymous structural detection, batch consensus, certificate
  vs batch calibration, transform models and identifiability limits.
- Guide/glossary: two-task workflow, detector-family examples, orientation prompt,
  certificate vs estimated accuracy.
- `TODO.md`: remove this work item; preserve only measured follow-ups.
- `HANDOVER.md`: one completion record with benchmark numbers and browser datasets.
- Delete this plan file.
