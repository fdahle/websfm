// Read text (components/modals/images/ReadTextModal.vue): the text read on the photos,
// and the values printed on them.
export default {
  title: 'Read Text',
  intro:
    'Finds and reads the text on each photo with PaddleOCR (13 MB, downloaded once): frame numbers, data ' +
    'strips, data cards. The focal length and date printed on a camera’s photos are read off them; ' +
    'the rule Text in <strong>Tools ▸ Images ▾ ▸ Auto mask…</strong> masks the text.',
  read: '{n, plural, one {Read # photo} other {Read # photos}}',
  readAgain: 'Read all again',
  cancel: 'Cancel',
  progress: 'Reading text: {done, number} of {total, number} photos',
  status: '{read, number} of {n, number} photos read · {lines, plural, one {# text line} other {# text lines}}',
  disabled: {
    busy: 'Wait for the reading to finish',
    allRead: 'Every photo is read; Read all again reads them anew',
    noImages: 'Import images first',
  },
  camera: {
    focal: 'Focal length read',
    date: 'Date read',
    none: 'nothing read',
    onPhotos: '{value} ({photos, number} of {of, number} photos)',
    focalValue: '{mm, number, ::.000} mm',
    current: 'camera: {mm, number, ::.000} mm',
    currentNone: 'camera: not set',
    use: 'Use {mm, number, ::.000} mm',
    same: 'The camera already has this focal length',
  },
  photo: 'Photo',
  text: 'Text read',
  unread: 'not read',
  noText: 'no text',
}
