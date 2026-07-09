export function createImage(file) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    uuid: crypto.randomUUID(),
    name: file.name,
    url: URL.createObjectURL(file),
    // Pixel source for detection/dense MVS when it must differ from `url` (a
    // TIFF's display blob is JPEG for speed; compute needs the lossless PNG
    // sibling instead — see utils/tiff.js). null ⇒ consumers fall back to `url`.
    computeUrl: null,
    // True while `url` is a not-yet-decodable TIFF blob — the UI shows a
    // placeholder instead of a broken <img> until the transcode replaces it.
    previewPending: false,
    // True if the TIFF transcode threw — `url` stays an undecodable raw blob
    // forever in this case, so the UI must keep showing a placeholder (an
    // error one, not "decoding…") instead of falling back to a broken <img>.
    previewFailed: false,
    file,
    meta: null,
    sensorId: null, // id of the Sensor (shared intrinsics) this image belongs to
    loading: true,
    keypoints: [],
    descriptors: null, // Float32Array (N×128) kept in-memory for matching
    kpStatus: 'idle', // 'idle' | 'running' | 'done' | 'error'
    kpCount: 0,
    kpMs: 0,
    mask: null, // { dataUrl: string } | null
    depth: null, // { dataUrl: string } | null
    // Clicked scan-pixel observations of the film sensor's fiducial marks (F4).
    // [{ fidId, px, py }]; only meaningful when the image's sensor is kind:'film'.
    fiducialObs: [],
  }
}
