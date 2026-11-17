// Reconstruct ▸ Sparse Model (components/modals/pipeline/ReconstructModal.vue).
export default {
  // Photos that look like scanned film, their sensors not classified (core/sensors/filmGuess.js).
  // {why}: the signs, sidebar.sensors.filmSign.*.
  filmGuess: {
    text:
      '{n, plural, one {# photo looks} other {# photos look}} like scanned film ({why}), but ' +
      '{groups, plural, one {its sensor is} other {their # sensors are}} not set to Film: the focal starts from ' +
      'a digital camera’s guess, far too long for an aerial film camera. As film, it starts from a 6-inch lens on ' +
      '9-inch film, and self-calibration refines it.',
    film: 'Treat as film',
    digital: 'They are digital',
  },
}
