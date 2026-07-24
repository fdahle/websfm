// Pure formatting helpers for the console log. Dependency-free (no Vue/DOM) so
// they live here and are unit-testable under the pure-module test scope, while
// the reactive log singleton stays in composables/useLog.js.

// Safety net for the "Reconstruction: Reconstruction…" duplication: the source
// badge already names the category, so a message that also opens with "<Source>: "
// repeats it. The message text is rewritten at the call sites to drop the prefix,
// but this strips any stray/legacy/miscategorised one at render + export time so a
// missed call (or a file logged under the wrong source) never doubles up. Only an
// exact case-insensitive "<source>: " head is removed — never a mid-sentence match,
// and never a different sub-stage label (e.g. "Mesh:" logged under "Products").
export function stripSourcePrefix(source, message) {
  if (!source || typeof message !== 'string') return message
  const head = `${source}: `
  if (message.length >= head.length &&
      message.slice(0, head.length).toLowerCase() === head.toLowerCase()) {
    return message.slice(head.length)
  }
  return message
}
