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
    // An image past the canvas limit (a native KH-9 scan) has no compute URL at all:
    // its pixels are a tiled pyramid ({ kind: 'pyramid', key, index, blob }, see
    // workers/rasterSource.js), read by the workers at the level a step needs.
    // `pyramidIndex` is the persisted half (the blob is an OPFS derived file).
    computePyramid: null,
    pyramidIndex: null,
    // True while `url` is a not-yet-decodable TIFF blob — the UI shows a
    // placeholder instead of a broken <img> until the transcode replaces it.
    previewPending: false,
    // True if the TIFF transcode threw — `url` stays an undecodable raw blob
    // forever in this case, so the UI must keep showing a placeholder (an
    // error one, not "decoding…") instead of falling back to a broken <img>.
    previewFailed: false,
    // Why `previewFailed` is set: 'decode' (the bytes are here but unreadable —
    // a failed TIFF transcode) or 'source-lost' (the blob URL's backing file
    // went away mid-session and OPFS had no usable copy; see
    // useImagesStore.reportImageLoadError). null while the image is fine.
    previewFailReason: null,
    file,
    meta: null,
    sensorId: null, // id of the Sensor (shared intrinsics) this image belongs to
    loading: true,
    // Keypoints live on disk + in useImagesStore's LRU, never on the record (TODO ▸ SC-3);
    // kpRev bumps whenever they are replaced, so a viewer knows to re-read them.
    kpRev: 0,
    descriptors: null, // Float32Array (N×128) kept in-memory for matching
    kpStatus: 'idle', // 'idle' | 'running' | 'done' | 'error'
    kpCount: 0,
    kpMs: 0,
    mask: null, // { dataUrl: string } | null
    depth: null, // { dataUrl: string } | null
    // List thumbnail { blob, url } (≤256 px JPEG) — what rows, tables and the 3D
    // camera glyphs show instead of `url`. Filled in the background
    // (useImagesStore.requestThumbnail); null until then.
    thumb: null,
    // Fiducial marks found or placed on the scan (F4): anonymous raster-relative
    // detections [{ slot, px, py, … }]. Calibration lives on the sensor and is
    // deliberately not required to populate these.
    fiducialDetections: [],
  }
}

// What a compute step (detection, depth, fiducials, ortho, …) reads: the pyramid of
// an image past the canvas limit, else the lossless compute URL, else the original.
export function computeSourceOf(img) {
  return img?.computePyramid ?? img?.computeUrl ?? img?.url ?? null
}

// A pyramid descriptor for the workers: the persisted index + the container Blob.
export function pyramidSource(uuid, index, blob) {
  return { kind: 'pyramid', key: `pyramid:${uuid}`, index, blob }
}
