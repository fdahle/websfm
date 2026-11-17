// Auto Mask (components/modals/images/AutoMaskModal.vue, composables/useAutoMaskRun.js,
// core/stepEffects/autoMask.js): masks the edges of the photos, the text on them, or both.
export default {
  title: 'Auto Mask',
  intro:
    'Masks the edges of the photos, the text on them, or both. Masked pixels are left out of feature ' +
    'detection and depth maps from their next run on.',
  photos: {
    label: 'Photos',
    all: 'All photos ({n, number})',
    sensor: '{name} ({n, number})',
  },
  step: {
    edges: 'Edges',
    text: 'Text',
    existing: 'Existing masks',
  },
  edges: {
    method: 'Method',
    off: 'Off',
    strip: 'Fixed strip',
    frame: 'Film frame',
    side: { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' },
    linked: 'Link all sides',
    inset: 'Inset',
    insetUnit: '% of the long side',
  },
  text: {
    enabled: 'Mask text',
    pad: 'Padding',
    recurring: "Text at the same place on a sensor's photos",
  },
  existing: {
    label: 'If a mask exists',
    merge: 'Merge',
    replace: 'Replace',
  },
  px: 'px',
  run: 'Mask {n, plural, one {# photo} other {# photos}}',
  disabled: {
    nothing: 'Turn on Edges or Text: there is nothing to mask yet',
    noSizes: 'The image sizes are not known yet: wait for the images to load',
  },
  effect: {
    edges: {
      off: 'Off: no edge is masked.',
      stripEven: 'A strip of {px, number} px along every edge of {n, plural, one {# photo} other {# photos}}.',
      strip:
        'A strip along the edges of {n, plural, one {# photo} other {# photos}}: top {top, number}, ' +
        'right {right, number}, bottom {bottom, number}, left {left, number} px.',
      stripZero: 'All sides are at 0 px: no edge is masked.',
      frame:
        'Finds where the photograph begins on each of {n, plural, one {# scan} other {# scans}}, past the dark ' +
        'film border and any bright scanner bed, and masks around it, {inset, number} % of the long side inside. ' +
        'Scans of one size are checked against each other: a side far off the others takes theirs.',
    },
    text: {
      off: 'Off: the text stays unmasked.',
      on:
        'Reads the text on {n, plural, one {# photo} other {# photos}} ({unread, plural, =0 {all read before} ' +
        'other {# to read with PaddleOCR, 13 MB downloaded once}}) and masks each line read clearly, ' +
        '{pad, number} px around it.',
      onRecurring:
        'Reads the text on {n, plural, one {# photo} other {# photos}} ({unread, plural, =0 {all read before} ' +
        'other {# to read with PaddleOCR, 13 MB downloaded once}}) and masks each line read clearly, ' +
        '{pad, number} px around it, and the text a sensor prints at the same place on all of its photos.',
    },
    existing: {
      none: 'None of these photos has a mask yet.',
      merge:
        'Merge: the new mask is added to the masks of the {m, plural, one {# photo} other {# photos}} that have one.',
      replace:
        'Replace: the new mask takes the place of the masks of the {m, plural, one {# photo} other {# photos}} ' +
        'that have one.',
    },
    // Appended to a step's line when some photos have no known size.
    unsized:
      '{line} {k, plural, one {# photo of unknown size is skipped.} other {# photos of unknown size are skipped.}}',
  },
  short: {
    edges: {
      stripEven: '{px, number} px strip',
      strip: 'strip {top, number}/{right, number}/{bottom, number}/{left, number} px',
      frame: 'film frame · {inset, number} %',
    },
    text: {
      on: '{pad, number} px',
      onRecurring: '{pad, number} px · recurring',
    },
    existing: {
      merge: 'merge',
      replace: 'replace',
    },
  },
  progress: {
    strip: 'Masking the edge strips',
    frame: 'Finding the film frames',
    read: 'Reading the text',
    text: 'Masking the text',
  },
  done: {
    strip: 'Edge strip on {masked, plural, one {# photo} other {# photos}}',
    frame:
      'Film frame on {masked, plural, one {# photo} other {# photos}}' +
      '{replaced, plural, =0 {} other {, # with a side from the others}}' +
      '{none, plural, =0 {} other {, # without a frame (see the log)}}' +
      '{failed, plural, =0 {} other {, # failed (see the log)}}',
    text:
      'Text on {masked, plural, one {# photo} other {# photos}}' +
      '{cleared, plural, =0 {} one {, # mask cleared (no text)} other {, # masks cleared (no text)}}' +
      '{skipped, plural, =0 {} other {, # skipped (see the log)}}' +
      '{failed, plural, =0 {} other {, # not read (see the log)}}',
    unsized: '{n, plural, one {# photo} other {# photos}} of unknown size skipped',
  },
  failed: 'Auto Mask failed',
}
