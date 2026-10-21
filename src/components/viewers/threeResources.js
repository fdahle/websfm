// three.js resources of the 3D view (Viewer3D.vue): the shader patch every cloud
// material shares, and freeing GPU memory without re-uploading what stays.

// Vertex colours go to the GPU as the style's own Uint8 sRGB bytes (normalized
// attribute, 3 B/point) and are decoded to linear in the vertex shader — Three.js
// shades vertex colours in linear space, and the source RGB, ramp colours and legend
// swatches are sRGB. A Float32 linear copy was 12 B/point on the CPU and the GPU
// (240 MB for a 20 M-point cloud). The decode is Three's own SRGBToLinear formula,
// so colours are unchanged. One shared function, so every cloud material shares a
// program (Three keys programs on onBeforeCompile's source).
export function srgbVertexColors(shader) {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
vec3 websfmSrgbToLinear(vec3 c) {
  return mix(c * 0.0773993808, pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), step(vec3(0.04045), c));
}`,
    )
    .replace(
      '#include <color_vertex>',
      `#include <color_vertex>
#ifdef USE_COLOR
  vColor.rgb = websfmSrgbToLinear(vColor.rgb);
#endif`,
    )
}

export function disposeMaterial(material, textures = new Set(), materials = new Set()) {
  for (const mat of Array.isArray(material) ? material : [material]) {
    if (!mat || materials.has(mat)) continue
    materials.add(mat)
    for (const value of Object.values(mat)) {
      if (value?.isTexture && !textures.has(value)) {
        textures.add(value)
        value.dispose()
      }
    }
    mat.dispose()
  }
}

export function disposeObject(root) {
  const textures = new Set()
  const materials = new Set()
  root?.traverse((obj) => {
    obj.geometry?.dispose()
    if (obj.material) disposeMaterial(obj.material, textures, materials)
  })
}

// A cloud layer's object plus the material it is not showing right now (a textured
// mesh swaps between its lit base material and one unlit material per atlas page).
export function disposeLayer(layer) {
  if (layer.lod) {
    layer.dispose()
    return
  }
  disposeObject(layer.object)
  const textures = new Set(),
    materials = new Set()
  if (layer.baseMaterial && layer.baseMaterial !== layer.object.material)
    disposeMaterial(layer.baseMaterial, textures, materials)
  if (layer.pageMaterials && layer.pageMaterials !== layer.object.material)
    disposeMaterial(layer.pageMaterials, textures, materials)
}

// Free the GPU buffers of the style-owned attributes (colour, a point cloud's
// class-filter index) WITHOUT touching the geometry's position/normal buffers or a
// mesh's triangle index. `geometry.dispose()` releases every attribute's buffer, so
// disposing to drop a replaced colour buffer used to re-upload the whole position
// buffer on each restyle (12 B/point). The kept attributes are detached for the
// dispose and re-attached: their GL buffers stay resident in the renderer, keyed by
// the attribute object, and the next draw reuses them as-is.
export function releaseStyleBuffers(geometry, { keepColor, keepIndex }) {
  const kept = []
  for (const name of Object.keys(geometry.attributes)) {
    if (name === 'color' && !keepColor) continue
    kept.push([name, geometry.getAttribute(name)])
    geometry.deleteAttribute(name)
  }
  const index = keepIndex ? geometry.index : null
  if (index) geometry.setIndex(null)
  geometry.dispose()
  for (const [name, attribute] of kept) geometry.setAttribute(name, attribute)
  if (index) geometry.setIndex(index)
}
