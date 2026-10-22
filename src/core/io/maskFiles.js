// Mask files → images, by file name. Pure: plain data in, plain data out.
//
// Tools write a folder of per-image masks under one of three naming schemes:
//
//   same name            IMG_0001.tif         (a mask folder beside the image folder)
//   COLMAP               IMG_0001.jpg.png     (the image's full name plus an extension)
//   Metashape template   IMG_0001_mask.png    ({filename}_mask; also -mask, .mask)
//
// Each file is tried against the images in that order, through the one name rule
// (core/io/nameMatch.js): exact name, basename, then case-insensitive name and stem.

import { makeNameResolver, basename } from './nameMatch.js'

/** File extensions read as mask images. */
export const MASK_FILE_EXT = /\.(png|jpe?g|tiff?|bmp|webp|gif)$/i

const MASK_SUFFIX = /[ _.-]mask$/i

/** The image names a mask file may stand for, in the order they are tried. */
export function maskFileCandidates(fileName) {
  const b = basename(fileName)
  const noExt = b.replace(/\.[^.]+$/, '')
  const out = [b]
  if (/\.[^.]+$/.test(noExt)) out.push(noExt) // COLMAP: IMG_0001.jpg.png
  if (MASK_SUFFIX.test(noExt)) out.push(noExt.replace(MASK_SUFFIX, '')) // IMG_0001_mask.png
  return out
}

/**
 * Pair mask files with images.
 *
 * @param {string[]} fileNames the chosen files' names (paths are fine)
 * @param {Array<{ id: any, name: string }>} images
 * @returns {{
 *   pairs: Array<{ index: number, imageId: any }>,   index into fileNames
 *   unmatched: string[],                              mask files that fit no image
 *   duplicates: string[],                             a further file for an image already paired
 *   skipped: string[],                                not an image file
 *   imagesWithout: number,                            images no file was found for
 * }}
 */
export function matchMaskFiles(fileNames, images) {
  const resolve = makeNameResolver(images)
  const out = { pairs: [], unmatched: [], duplicates: [], skipped: [], imagesWithout: 0 }
  // Per image, the file whose name says "mask" most plainly: a COLMAP or Metashape
  // name beats a file of the image's own name, so a folder holding the images and
  // their masks side by side pairs each image with its mask, not with itself.
  const best = new Map() // imageId → { index, tier }
  fileNames.forEach((name, index) => {
    if (!MASK_FILE_EXT.test(name)) {
      out.skipped.push(basename(name))
      return
    }
    const candidates = maskFileCandidates(name)
    let imageId = null
    let tier = 0
    for (; tier < candidates.length; tier++) {
      imageId = resolve(candidates[tier])
      if (imageId != null) break
    }
    if (imageId == null) {
      out.unmatched.push(basename(name))
      return
    }
    const prev = best.get(imageId)
    if (prev && prev.tier >= tier) out.duplicates.push(basename(name))
    else {
      if (prev) out.duplicates.push(basename(fileNames[prev.index]))
      best.set(imageId, { index, tier })
    }
  })
  for (const [imageId, { index }] of best) out.pairs.push({ index, imageId })
  out.pairs.sort((a, b) => a.index - b.index)
  out.imagesWithout = images.length - best.size
  return out
}
