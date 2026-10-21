// The camera glyphs of the 3D view (Viewer3D.vue): a frustum per registered camera,
// textured with the image's list thumbnail, sized by how tightly the cameras were
// shot. `view` reads the viewer's renderer state (scene, unmounted) live.
import * as THREE from 'three'
import { watch } from 'vue'
import { useViewerSettings } from '../../composables/useViewerSettings.js'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { cameraFrustumDepth } from './viewerFraming.js'

export function useCameraFrustums({ view, images, requestRender }) {
  const { cameraScale } = useViewerSettings()
  const imagesStore = useImagesStore()

  const frustumGroup = new THREE.Group()
  // Camera glyphs are shared unit geometry placed by a per-camera matrix, so a
  // cameraScale step only rewrites matrices. Thumbnails are small (THUMB_PX²)
  // textures cached by image across rebuilds: re-decoding every full-resolution
  // photo and uploading it to the GPU on each size step or sparse-cloud toggle was
  // the lag. The texture source is the image's LIST THUMBNAIL (img.thumb, ≤256 px,
  // useImagesStore) — never the full-resolution photo, which for 5,000 cameras meant
  // 5,000 full decodes per session. A missing thumbnail is requested in the
  // background; `thumbsVersion` says when one lands. An entry is dropped only when
  // its image is removed.
  const THUMB_PX = 256
  const THUMB_DECODES = 4 // concurrent thumbnail decodes (each ≤ THUMB_PX², cheap)
  const thumbCache = new Map() // uuid → { url, tex, mat, queued, disposed }
  const thumbQueue = []
  let thumbActive = 0
  let thumbSyncRaf = 0
  let frustumLineMat = null, frustumLineGeo = null, frustumPlaneGeo = null

  // Removes the glyphs only; geometry, materials and thumbnails are shared/cached.
  function clearFrustums() {
    frustumGroup.clear()
  }

  function disposeThumb(entry) {
    entry.disposed = true
    entry.mat.dispose()
    entry.tex.image?.close?.()
    entry.tex.dispose()
  }

  function disposeFrustumResources() {
    clearFrustums()
    for (const entry of thumbCache.values()) disposeThumb(entry)
    thumbCache.clear()
    thumbQueue.length = 0
    frustumLineMat?.dispose(); frustumLineGeo?.dispose(); frustumPlaneGeo?.dispose()
    frustumLineMat = frustumLineGeo = frustumPlaneGeo = null
  }

  function pumpThumbQueue() {
    while (thumbActive < THUMB_DECODES && thumbQueue.length) {
      const entry = thumbQueue.shift()
      entry.queued = false
      if (entry.disposed || !entry.url) continue
      const url = entry.url
      thumbActive++
      // createImageBitmap decodes off the main thread and resizes in one step.
      // The bitmap is flipped here because WebGL ignores UNPACK_FLIP_Y for it.
      fetch(url)
        .then(r => r.blob())
        .then(blob => createImageBitmap(blob, {
          resizeWidth: THUMB_PX, resizeHeight: THUMB_PX, resizeQuality: 'medium', imageOrientation: 'flipY',
        }))
        .then((bitmap) => {
          if (entry.disposed || entry.url !== url) { bitmap.close(); return }
          entry.tex.image?.close?.()
          entry.tex.image = bitmap
          entry.tex.needsUpdate = true
          requestRender()
        })
        .catch(() => {}) // a dead blob: url just leaves the quad untextured
        .finally(() => { thumbActive--; pumpThumbQueue() })
    }
  }

  function thumbEntry(uuid) {
    let entry = thumbCache.get(uuid)
    if (entry) return entry
    const tex = new THREE.Texture()
    tex.colorSpace = THREE.SRGBColorSpace
    tex.flipY = false
    entry = { url: null, tex, mat: new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }), queued: false, disposed: false }
    thumbCache.set(uuid, entry)
    return entry
  }

  // Point a glyph's texture at the image's list thumbnail; load it when it changed.
  function syncThumb(entry, img) {
    const url = img.thumb?.url ?? null
    if (!url || entry.url === url) return
    entry.url = url
    if (!entry.queued) { entry.queued = true; thumbQueue.push(entry) }
    pumpThumbQueue()
  }

  // A thumbnail landed somewhere (thumbsVersion moved): re-point the glyphs, one pass
  // per frame however many arrived.
  function scheduleThumbSync() {
    if (!thumbSyncRaf) thumbSyncRaf = requestAnimationFrame(syncAllThumbs)
  }
  function syncAllThumbs() {
    thumbSyncRaf = 0
    if (!thumbCache.size) return
    const imgByUuid = new Map(images().map((im) => [im.uuid, im]))
    for (const [uuid, entry] of thumbCache) {
      const img = imgByUuid.get(uuid)
      if (img) syncThumb(entry, img)
    }
  }

  // Missing thumbnails are asked for only once the glyphs are actually drawn (the view
  // in front, cameras shown): a hidden 3D tab must not make a freshly opened
  // 5,000-image project generate a thumbnail for every camera. Background priority.
  let thumbRequestsPending = false
  function requestMissingThumbs() {
    thumbRequestsPending = false
    const imgByUuid = new Map(images().map((im) => [im.uuid, im]))
    for (const [uuid, entry] of thumbCache) {
      const img = imgByUuid.get(uuid)
      if (img && !entry.url && !img.thumb && !img.previewFailed) imagesStore.requestThumbnail(img)
    }
  }

  function ensureFrustumGeometry() {
    if (frustumLineGeo) return
    frustumLineMat = new THREE.LineBasicMaterial({ color: 0xff8844 })
    // Unit frustum in camera space (x right, y down, +z forward), depth 1.
    // corners = [BL-in-image, BR, TR, TL]; 4 centre→corner edges + the far face.
    const h = 0.5
    const c = [[-h, -h, 1], [h, -h, 1], [h, h, 1], [-h, h, 1]]
    const lines = []
    for (const p of c) lines.push(0, 0, 0, ...p)
    for (let i = 0; i < 4; i++) lines.push(...c[i], ...c[(i + 1) % 4])
    frustumLineGeo = new THREE.BufferGeometry()
    frustumLineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3))
    frustumLineGeo.computeBoundingSphere()
    // Thumbnail quad on the far face. The bitmap is pre-flipped (row 0 at v=1),
    // so the image's top row maps to the y=-h corners.
    frustumPlaneGeo = new THREE.BufferGeometry()
    frustumPlaneGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(c.flat()), 3))
    frustumPlaneGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2))
    frustumPlaneGeo.setIndex([0, 1, 2, 0, 2, 3])
    frustumPlaneGeo.computeBoundingSphere()
  }

  // world = Rᵀ·(s·local) + C — camera-to-world, uniformly scaled by the frustum depth.
  function placeFrustum(obj, depth) {
    const { R, centre: C } = obj.userData
    obj.matrix.set(
      R[0][0] * depth, R[1][0] * depth, R[2][0] * depth, C.x,
      R[0][1] * depth, R[1][1] * depth, R[2][1] * depth, C.y,
      R[0][2] * depth, R[1][2] * depth, R[2][2] * depth, C.z,
      0, 0, 0, 1,
    )
    obj.matrixWorldNeedsUpdate = true
  }

  function scaleFrustums(depth) {
    for (const obj of frustumGroup.children) placeFrustum(obj, depth)
  }

  // Cached frustum inputs so a cameraScale change can rebuild frustums cheaply
  // without recomputing the whole cloud.
  let lastCams = []
  let lastBaseDepth = 0.15

  // (Re)build the camera-frustum glyphs at the given depth. Cheap: geometry is
  // shared and thumbnails come from thumbCache, so only per-camera objects are new.
  function buildFrustums(cams, frustumDepth) {
    clearFrustums()
    ensureFrustumGeometry()
    const imgByUuid = new Map(images().map((im) => [im.uuid, im]))
    for (const [uuid, entry] of thumbCache) {
      if (!imgByUuid.has(uuid)) { disposeThumb(entry); thumbCache.delete(uuid) }
    }

    for (const { uuid, R, centre } of cams) {
      const obj = new THREE.Object3D()
      obj.matrixAutoUpdate = false
      obj.userData = { R, centre }
      obj.add(new THREE.LineSegments(frustumLineGeo, frustumLineMat))
      const img = imgByUuid.get(uuid)
      if (img) {
        const entry = thumbEntry(uuid)
        obj.add(new THREE.Mesh(frustumPlaneGeo, entry.mat))
        syncThumb(entry, img)
        if (!entry.url) thumbRequestsPending = true
      }
      placeFrustum(obj, frustumDepth)
      frustumGroup.add(obj)
    }
  }

  // Ribbon steppers — cheap live updates, no cloud recompute.
  watch(cameraScale, () => { scaleFrustums(lastBaseDepth * cameraScale.value); requestRender() })
  // A list thumbnail can land after the frustums were built (generated in the
  // background, or regenerated). One counter instead of a watch over every image.
  watch(() => imagesStore.thumbsVersion, scheduleThumbSync)
  // An image joining or leaving re-points glyphs too (a camera whose image arrives
  // late). Debounced: a multi-thousand-image drop changes the length once per file,
  // and each rebuild touches every camera.
  let frustumRebuildTimer = 0
  watch(() => images().length, () => {
    clearTimeout(frustumRebuildTimer)
    frustumRebuildTimer = setTimeout(() => {
      if (view.unmounted || !view.scene || !lastCams.length) return
      buildFrustums(lastCams, lastBaseDepth * cameraScale.value)
      requestRender()
    }, 300)
  })

  // The cameras of the drawn layers changed: place a glyph per camera, sized by
  // their spacing (cameraFrustumDepth) and the ribbon's camera size.
  function setCameras(cameras) {
    lastCams = [...cameras].map(([uuid, { R, t }]) => ({ uuid, R, centre: new THREE.Vector3(
      -(R[0][0]*t[0] + R[1][0]*t[1] + R[2][0]*t[2]),
      -(R[0][1]*t[0] + R[1][1]*t[1] + R[2][1]*t[2]),
      -(R[0][2]*t[0] + R[1][2]*t[1] + R[2][2]*t[2]),
    ) }))
    lastBaseDepth = cameraFrustumDepth(lastCams.map(c => c.centre), [])
    buildFrustums(lastCams, lastBaseDepth * cameraScale.value)
  }

  // Called after each frame: thumbnails are asked for only once the glyphs are drawn.
  function afterFrame() {
    if (thumbRequestsPending && frustumGroup.visible) requestMissingThumbs()
  }

  function dispose() {
    if (thumbSyncRaf) cancelAnimationFrame(thumbSyncRaf)
    clearTimeout(frustumRebuildTimer)
    disposeFrustumResources()
  }

  return { frustumGroup, setCameras, afterFrame, dispose }
}
