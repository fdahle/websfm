// Mask groups: the image list split by resolution, as the Mask Manager and Auto
// Mask dialogs show it. A mask is a raster at the image's own pixel size, so one
// mask (an imported file, a border in px) can only be shared by images of the
// same width × height. Images without known dimensions fall into one 'unknown'
// group, which the dialogs list but cannot bulk-apply to.
//
// Pure: takes the image list, returns plain data. Groups keep first-seen order
// and images keep list order within a group.

export const MASK_HINT = 'Red regions are excluded from feature detection and the dense cloud — applied on the next detect/dense run.'

export function maskGroups(images) {
  const map = new Map()
  for (const img of images) {
    const w = img.meta?.width, h = img.meta?.height
    const key = w && h ? `${w}×${h}` : 'unknown'
    if (!map.has(key)) map.set(key, { key, w: w || null, h: h || null, label: w && h ? `${w} × ${h}` : 'Unknown size', images: [] })
    map.get(key).images.push(img)
  }
  const groups = [...map.values()]
  const maskedCount = images.filter((i) => i.mask).length
  return {
    groups,
    // The groups a bulk action can reach (known width and height).
    sizedGroups: groups.filter((g) => g.w && g.h),
    maskedCount,
    // The dialogs' sub-bar line.
    hint: `${maskedCount} of ${images.length} masked. ${MASK_HINT}`,
  }
}
