// Marks vs keypoints: two pixel conventions.
//
// Marks (GCP / marker / scale-bar clicks, imported Metashape marks, Find-GCPs
// candidates, fiducial and reseau detections) use the viewer's pixel-EDGE convention:
// the image's top-left corner is (0, 0), pixel i spans [i, i + 1] and its centre is
// i + ½ (ViewerImage toImagePixel). Keypoints, K and every camera projection use pixel
// CENTRES at integers. Convert at the boundary — marks into the camera frame
// (displayFrame.js makeScanToPinhole, sfm.js GCP ingest, fiducialModel.js
// calibratedFiducialPairs) and camera-frame positions back into marks
// (makePinholeToMark) — never in storage. GeoScan checkpoints: H 4.2 → 3.3 cm, V 8.1 →
// 7.1 cm (2026-10-06).
//
// A leaf module, so any module can import it without a cycle.

export const markToCentrePx = (x) => x - 0.5
export const centreToMarkPx = (x) => x + 0.5
