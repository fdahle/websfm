// Auto Mask (components/modals/images/AutoMaskModal.vue): masks from a rule, the border
// or the text on the photos.
export default {
  title: 'Auto Mask',
  rule: {
    label: 'Rule',
    border: 'Border',
    frame: 'Frame',
    text: 'Text',
  },
  border: {
    title: 'Mask border',
    hint: '(exclude outer pixels)',
    side: { top: 'top', right: 'right', bottom: 'bottom', left: 'left' },
    linked: 'Link all sides',
  },
  frame: {
    title: 'Mask the film frame',
    hint: '(found on each scan)',
    inset: 'Inset',
    insetUnit: '% of the long side',
    about:
      'Finds where the photograph begins on each scan, past the dark film border and any bright scanner bed, ' +
      'and masks the frame around it. Scans of one size are checked against each other: a side far off the ' +
      'others takes theirs.',
    progress: 'Finding frames: {done, number} of {total, number} photos',
    groupFound: 'frame found on {found, number} of {n, number}',
    done:
      '{masked, plural, one {# photo} other {# photos}} masked' +
      '{replaced, plural, =0 {} one {, # with a side from the others} other {, # with a side from the others}}' +
      '{none, plural, =0 {} other {, # without a frame (see the log)}}' +
      '{failed, plural, =0 {} other {, # failed (see the log)}}',
  },
  text: {
    title: 'Mask text',
    hint: '(frame numbers, data strips, annotations)',
    pad: 'Padding',
    recurring: "Text at the same place on a camera's photos",
    about:
      'Finds and reads the text on each photo with PaddleOCR (13 MB, downloaded once). ' +
      'What it reads is kept, so a later run with other settings is quick.',
    reading: 'Reading text: {done, number} of {total, number} photos',
    masking: 'Writing masks: {done, number} of {total, number} photos',
    groupRead: '{read, number} of {n, number} read · {lines, plural, one {# text line} other {# text lines}}',
    groupUnread: 'not read yet',
    done:
      '{masked, plural, one {# photo} other {# photos}} masked' +
      '{cleared, plural, =0 {} one {, # mask cleared (no text)} other {, # masks cleared (no text)}}' +
      '{skipped, plural, =0 {} other {, # skipped (see the log)}}' +
      '{failed, plural, =0 {} other {, # not read (see the log)}}',
  },
  existing: {
    label: 'If a mask exists',
    merge: 'Merge',
    replace: 'Replace',
  },
  px: 'px',
  applyAll: 'Apply to all groups',
  applyGroup: 'Apply to group',
  cancel: 'Cancel',
  empty: 'No images.',
  group: {
    size: '{w} × {h}',
    unknown: 'Unknown size',
    count: '{n, plural, one {# image} other {# images}}',
  },
  hint:
    '{masked, number} of {n, number} masked. Red regions are excluded from feature detection and the dense ' +
    'cloud, applied on the next detect or dense run.',
  disabled: {
    busy: 'Wait for the masks to be written',
    noSizes: 'The image sizes are not known yet: wait for the images to load',
    unknownSize: 'Unknown size: open an image to draw a mask by hand',
  },
  failed: {
    title: 'Auto Mask failed',
    detail: '{done, number} of {total, number} images masked before {name} failed: {why}',
  },
}
