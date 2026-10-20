// One TIFF / COG tile as a zlib (DEFLATE, TIFF compression 8) stream, by the platform's
// CompressionStream: the `compress` hook of core/products/geotiff.js createCogBuilder,
// kept as a Blob part (off the heap; assembleCog takes parts).
export async function deflateTile(bytes) {
  const part = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).blob()
  return { length: part.size, part }
}
