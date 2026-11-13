// The external store's edits to a raster: its kind (DEM / ortho), its display style
// (with the preview repaint) and its accuracy and vertical datum.
//
// Moved verbatim from the store: everything it shares comes in by name.

import { toRaw } from 'vue'
import { describeStyle, styleStamp, resolveRasterStyle, bandsUsedBy } from '../../core/io/rasterStyle.js'
import { parseRasterFile, restyleRasterPreview } from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'

export function createRasterStyle({
  buildSource,
  isPersisting,
  log,
  originalFile,
  projects,
  rasterById,
  save,
  setSource,
  sources,
  styleRequests,
}) {
  // ── mutation ───────────────────────────────────────────────────────────────
  // Flip a raster's kind after import ("Treat as DEM / orthophoto").
  //
  // This action is what makes skipping the import modal on a high-confidence
  // sniff defensible — without it a silent misclassification is a
  // delete-and-reimport. It also covers the genuinely undecidable case: an 8-bit
  // hillshade is a DEM by intent and imagery by content, and only the user knows
  // which they want.
  //
  // The geotransform is identical either way, but the *plane* is not (Float32
  // elevations vs RGBA pixels), so this re-decodes from the retained original
  // rather than relabelling bytes that would then be read as the wrong type.
  async function setRasterKind(id, kind) {
    const meta = rasterById(id)
    if (!meta || meta.kind === kind) return false

    const file = await originalFile(id)
    if (!file) {
      log(
        `Reference raster "${meta.name}": the original file is no longer stored, so it ` +
          `cannot be re-read as a ${kind.toUpperCase()}. Re-import it and pick the kind in ` +
          'the import dialog.',
        'warn',
        'Import',
      )
      return false
    }

    let next, plane
    try {
      const buffer = await file.arrayBuffer()
      ;({ meta: next, plane } = await parseRasterFile(buffer, meta.name, {
        forceKind: kind,
        onLog: (m, l, c) => log(m, l, c),
      }))
    } catch (err) {
      log(
        `Reference raster "${meta.name}": re-decode as ${kind.toUpperCase()} failed — ` + `${err?.message ?? err}`,
        'error',
        'Import',
      )
      return false
    }

    // Keep the user's own fields (name, vertical declarations); replace only what
    // the decode determines.
    Object.assign(meta, next, {
      id: meta.id,
      name: meta.name,
      importedAt: meta.importedAt,
      horizontalAccuracy: meta.horizontalAccuracy,
      verticalAccuracy: meta.verticalAccuracy,
      vOffset: meta.vOffset,
      // A vertical datum the *user* set survives; one merely defaulted from the
      // geokeys is re-derived.
      verticalDatum: meta.verticalDatumUserSet ? meta.verticalDatum : next.verticalDatum,
    })
    // This DID compose the plane, so the cached pixels are current by definition.
    meta.planeStyleStamp = styleStamp(meta.style)

    setSource(id, buildSource(meta, plane))
    if (isPersisting()) {
      await opfs.saveExternalPlane(projects.currentProjectId, id, plane.buffer).catch(() => {})
      await save()
    }
    log(`Reference raster "${meta.name}": now treated as ${kind.toUpperCase()}`, 'success', 'Import')
    return true
  }

  // Band math / contrast stretch for a multi-band or high-bit-depth raster.
  //
  // Same shape as setRasterKind, and for the same reason: the plane stored here
  // is baked 8-bit RGBA, so a restyle is a RE-DECODE from the retained original,
  // not a recolour of bytes we still have. Keeping the raw uint16 bands around
  // to avoid that would cost 300 MB for one Sentinel-2 scene — exactly the
  // memory the lazy-loading design exists to avoid.
  // Band math / contrast stretch for a multi-band or high-bit-depth raster.
  //
  // Deliberately does NOT rebuild the full-resolution plane. Everything the user
  // can see — the map layer, the raster tab — draws `previewDataUrl`, so the
  // restyle recomputes only that (≤1024 px, read straight out of geotiff at
  // preview size: tens of milliseconds). Re-decoding every band at full res and
  // writing hundreds of MB back to OPFS, which is what this used to do before the
  // preview repainted, made a dropdown change take seconds for no visible gain.
  //
  // The plane is instead **invalidated**: the loaded source is dropped and the
  // stamp on the persisted sidecar now disagrees with the style, so
  // `ensureRasterLoaded` re-decodes it at full res the next time something
  // actually samples pixels. That is the same lazy-hydration bargain the store is
  // built on (invariant 1) — the cost lands on the consumer that needs the
  // precision, not on the user nudging a gamma slider.
  async function setRasterStyle(id, style) {
    const meta = rasterById(id)
    if (!meta) return false
    const projectId = projects.currentProjectId
    const request = Symbol()
    styleRequests.set(id, request)

    const file = await originalFile(id)
    if (!file) {
      log(
        `Reference raster "${meta.name}": the original file is no longer stored, so it ` +
          'cannot be re-styled. Re-import it to change the band mapping.',
        'warn',
        'Import',
      )
      return false
    }

    let resolved, previewDataUrl
    try {
      const requested = resolveRasterStyle(style, meta)
      const used = bandsUsedBy(requested),
        previous = meta.style
      const sameRanges =
        previous &&
        ['mode', 'stretch', 'loPct', 'hiPct'].every((k) => previous[k] === requested[k]) &&
        JSON.stringify(bandsUsedBy(previous)) === JSON.stringify(used)
      const manual =
        requested.stretch === 'manual' &&
        used.every(
          (_, i) =>
            requested.manual?.[i]?.length === 2 &&
            requested.manual[i].every(Number.isFinite) &&
            requested.manual[i][1] > requested.manual[i][0],
        )
      if (meta.gpuReady && (requested.mode === 'index' || manual || sameRanges)) {
        resolved = {
          ...requested,
          ranges: requested.mode === 'index' ? [] : manual ? requested.manual : previous.ranges,
        }
      } else {
        ;({ style: resolved, previewDataUrl } = await restyleRasterPreview(file, meta.name, style, {
          rangesOnly: !!meta.gpuReady,
          cacheKey: `${projectId}:${id}:${meta.importedAt}:${file.size}:${file.lastModified}`,
          onLog: (m, l, c) => log(m, l, c),
        }))
      }
    } catch (err) {
      log(`Reference raster "${meta.name}": re-style failed — ${err?.message ?? err}`, 'error', 'Import')
      return false
    }

    if (projectId !== projects.currentProjectId || rasterById(id) !== meta || styleRequests.get(id) !== request)
      return false
    styleRequests.delete(id)
    meta.style = resolved
    if (previewDataUrl) meta.previewDataUrl = previewDataUrl

    // Drop the hydrated plane: it was composed with the old style, and serving it
    // to a sampler now would return colours that no longer match what is drawn.
    // A DEM's plane is the raw elevations, which no style touches: it stays.
    if (meta.kind !== 'dem' && sources.value.has(id)) {
      const next = new Map(sources.value)
      next.delete(id)
      sources.value = next
    }

    if (isPersisting()) await save()
    log(
      `Reference raster "${meta.name}": restyled — ${describeStyle(meta.style)}` +
        (meta.gpuReady ? ' (GPU display updated)' : ' (preview updated)'),
      'success',
      'Import',
    )
    // The GPU path restyles the tiles without composing a preview, but the preview
    // is still what the sidebar, the fallback <img>, a non-tiled map layer and the
    // next reopen draw. Repaint it off the critical path; a newer restyle wins.
    if (!previewDataUrl) refreshPreviewAfterRestyle(id, meta, resolved, file, projectId)
    return true
  }

  function refreshPreviewAfterRestyle(id, meta, style, file, projectId) {
    restyleRasterPreview(file, meta.name, style, {
      cacheKey: `${projectId}:${id}:${meta.importedAt}:${file.size}:${file.lastModified}`,
    })
      .then(async ({ previewDataUrl }) => {
        if (
          !previewDataUrl ||
          projectId !== projects.currentProjectId ||
          rasterById(id) !== meta ||
          toRaw(meta.style) !== style
        )
          return
        meta.previewDataUrl = previewDataUrl
        if (isPersisting()) await save()
      })
      .catch((err) =>
        log(`Reference raster "${meta.name}": preview refresh failed — ` + `${err?.message ?? err}`, 'warn', 'Import'),
      )
  }

  // Declared accuracy and vertical datum (§A6, A-5). All user-supplied because
  // none is reliably in the file, and all matter: the datum bounds a systematic
  // error, the vertical accuracy is what a filled GCP Z claims as its σ, and the
  // horizontal accuracy (the raster's absolute geolocation, 1σ in metres) is
  // what a position picked off it claims beyond its pixel size.
  async function setRasterAccuracy(id, { horizontalAccuracy, verticalDatum, verticalAccuracy, vOffset } = {}) {
    const meta = rasterById(id)
    if (!meta) return false
    if (horizontalAccuracy !== undefined) meta.horizontalAccuracy = horizontalAccuracy
    if (verticalDatum !== undefined) {
      meta.verticalDatum = verticalDatum
      meta.verticalDatumUserSet = true
    }
    if (verticalAccuracy !== undefined) meta.verticalAccuracy = verticalAccuracy
    if (vOffset !== undefined) meta.vOffset = vOffset
    log(
      `Reference raster "${meta.name}": ` +
        `${meta.horizontalAccuracy != null ? `σ horizontal ${meta.horizontalAccuracy}` : 'horizontal accuracy undeclared'}` +
        `${meta.kind === 'dem' ? `, vertical datum ${meta.verticalDatum}` : ''}` +
        `${meta.verticalAccuracy != null ? `, σ vertical ${meta.verticalAccuracy}` : ''}` +
        `${meta.vOffset ? `, offset ${meta.vOffset}` : ''}`,
      'info',
      'Import',
    )
    await save()
    return true
  }

  return { setRasterAccuracy, setRasterKind, setRasterStyle }
}
