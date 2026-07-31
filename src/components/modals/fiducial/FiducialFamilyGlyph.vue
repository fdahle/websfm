<script setup>
// A small picture of what one fiducial-mark family looks like on film — the example
// shown on each Detection-type card in FiducialDetectModal.
//
// These draw the mark *as it appears on the film* — what the user has to recognise in
// their own scans — following the shapes `core/sfm/fiducialPrimitives.js`
// `makeFiducialPrototype` describes:
//   generic     → its three swept variants: dot · crosshair · ring+centre
//   right-angle → two strokes meeting at a right angle (four orientations are swept)
//   cut-45      → the 45° diagonal plus the dot centred above it
//   frame       → no template at all; the corner of the detected film frame is the point
// They are NOT pixel-faithful renders of the correlation templates: those are coarse
// (a mark spans a 9–25 px patch, so every stroke is several pixels thick and the ring
// nearly fills its patch). Drawing them at that weight would be a picture of the
// matcher's resolution rather than of a fiducial mark.
// Everything draws in `currentColor`, so the active card tints its own example.
defineProps({
  family: { type: String, required: true },
})
</script>

<template>
  <svg class="fid-glyph" viewBox="0 0 64 48" width="60" height="45" aria-hidden="true">
    <!-- Film tile, so each mark reads as sitting on a scan rather than floating. -->
    <rect class="film" x="2.5" y="2.5" width="59" height="43" rx="3" />

    <!-- Generic: the three swept templates side by side. -->
    <g v-if="family === 'generic'" class="mark">
      <circle cx="13" cy="24" r="3.5" class="fill" />
      <path d="M32 18.5 V29.5 M26.5 24 H37.5" />
      <circle cx="50" cy="24" r="5.5" />
      <circle cx="50" cy="24" r="1.7" class="fill" />
    </g>

    <!-- Right angle: corner at the mark centre, arms along +x and +y. -->
    <path v-else-if="family === 'right-angle'" class="mark thick" d="M21 13 H44 M21 13 V36" />

    <!-- 45° cut: the diagonal, plus the dot a quarter-patch straight above its centre
         (template: dx = 0, dy = −0.25·S), which leaves it just clear of the line. -->
    <g v-else-if="family === 'cut-45'" class="mark">
      <path class="thick" d="M18 38 L46 10" />
      <circle cx="32" cy="14" r="3.6" class="fill" />
    </g>

    <!-- Frame: the film area inside the scan; its corner is the measured point. -->
    <g v-else class="mark">
      <rect class="edge area" x="20" y="15" width="38" height="28" />
      <circle cx="20" cy="15" r="4.5" />
      <circle cx="20" cy="15" r="1.6" class="fill" />
    </g>
  </svg>
</template>

<style scoped>
.fid-glyph { display: block; }
.film {
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  opacity: 0.25;
}
.mark {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
}
.mark .thick, .mark.thick { stroke-width: 3.2; }
.mark .edge { stroke-width: 1.4; opacity: 0.55; }
.mark .area { fill: currentColor; fill-opacity: 0.13; }
.mark .fill { fill: currentColor; stroke: none; }
</style>
