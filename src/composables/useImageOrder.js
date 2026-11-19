import { shallowRef } from 'vue'

// The photos in the order the image list shows them, grouped as it groups them (by
// image group or by sensor), collapsed groups included. ImagesSection keeps it up to
// date; Picture ▸ Previous / Next and their keys step through it (core/imageOrder.js).
// Empty until the list has drawn, when the images store's own order stands in.
export const imageListOrder = shallowRef([])
