---
id: texture-mesh
title: Texture a Mesh
summary: Paints a mesh with the photos themselves, so it shows the detail of the images rather than the colour of its vertices.
category: Products and export
order: 105
---
**Tools ▸ Mesh ▸ Texture…** gives a mesh a photo texture: every triangle shows the
pixels of one photo that sees it well. The result is a new mesh with a
[texture atlas](help:texture-atlas); the mesh you start from is left as it is. Vertex
colour, which [Build Mesh](guide:mesh) transfers from the dense cloud, only has one
colour per corner, so it blurs anything smaller than a triangle. A texture keeps the
detail of the photos however large the triangles are.

## Before you run
You need a mesh and the sparse model whose cameras took the photos. Texture works on
any mesh in the project's frame: a built one, a cleaned, decimated or cropped copy, or
an imported one. A mesh whose triangles do not share their corners, as in an STL file,
is welded first, and the log says so.

Texture a decimated mesh rather than the full Poisson result. A few hundred thousand
triangles look the same once textured, because the texture carries the detail, and the
run, the file and the viewer are all lighter for it.

## How it works
For every photo, the mesh is drawn into a depth buffer to find which triangles the photo
really sees, not hidden behind something nearer, and how many pixels it gives each one.
[View selection](help:view-selection) then picks one photo per triangle. It prefers the
photo that sees the triangle largest and sharpest, but it also keeps neighbouring
triangles on the same photo, because every change of photo is a seam. Neighbouring
triangles with the same photo form a chart. A chart is cut straight out of its photo, so
the texture is the photo's own pixels, resampled once through the lens model.

A triangle that something hides in every photo, such as a wall behind a tree, still
takes the photo that hides least of it: Poisson closes trees into solid shapes, while
the photos see the wall between the leaves. Only triangles that face away from every
photo, such as an underside, are left without one (see **Faces no photo sees**).

## Texture resolution
<!-- param: maxScale default: Native photo pixels -->
The finest texel size, measured in photo pixels. **Native photo pixels** keeps all the
detail the photos have. The resolution is lowered further, automatically, when the
atlas would not fit **Maximum pages**, and the log gives the texel size it settled on.

## Page size
<!-- param: pageSize default: 4096 -->
The side length of one atlas page. 4096 works in every browser and 3D program;
8192 holds four times as much per page, but some programs and older graphics cards
cannot display it. The 3D view shrinks a page it cannot display, but the file keeps
the full size.

## Maximum pages
<!-- param: maxPages default: 8 -->
The most atlas pages the texture may use. When the charts at the chosen resolution need
more, the resolution drops until they fit. Raise it for a large model you want at full
detail. Each 4096 × 4096 page needs about 64 MB of graphics memory in the 3D view.

## Level colours
<!-- param: levelColours default: true -->
Photos of the same surface rarely agree exactly in brightness and white balance, and
the difference shows as a step at every seam. Levelling works in two steps. First each
photo gets a gain per colour channel from the triangles it shares with the others, the
same correction the mosaicked [orthophoto](guide:orthophoto) uses; samples where one
photo shows something the others do not (a branch in front) are left out of that fit.
Then [seam levelling](help:seam-levelling) brightens or darkens each chart smoothly so
the two sides of every seam meet. Switch it off only to see the photos as they were
taken.

## Faces no photo sees
<!-- param: unseen default: Flat colour -->
Triangles that face away from every photo, such as the underside of an object or the
back of a wall nobody photographed, cannot be textured. **Flat colour** keeps them,
each in one colour from the mesh's vertex colours (grey without), so the mesh stays
closed. **Remove** leaves them out of the textured mesh, which suits a model for
viewing where those surfaces would only show as blotches.

## Use masks
<!-- param: useMasks default: true -->
Leaves out the pixels the [image masks](guide:masks) exclude, so people, vehicles,
the sky or the aircraft's own legs never end up in the texture. A triangle that only
masked pixels see falls back to another photo, or to a flat colour.

## Seam penalty
<!-- param: smoothness default: 0.5 -->
How strongly view selection keeps neighbouring triangles on the same photo. Higher
values give fewer, larger charts, so fewer seams, at the price of using a slightly less
direct photo here and there. **0** takes the best photo for every triangle on its own,
which scatters seams across the surface.

## Viewing and export
The 3D view shows the texture by default (**Colour by ▸ Texture** in the layer's
symbology; RGB still shows the vertex colours).

**Export ▸ Mesh** keeps the texture in two formats:

- **glTF binary (.glb)** embeds the atlas pages in the one file. Blender, web viewers,
  Cesium, Unity and Unreal all read it. The materials are unlit, because the photos
  already hold the light; a program that ignores that setting may shade the texture.
- **Wavefront OBJ** downloads a .zip with the .obj, its material file (.mtl) and one
  JPEG per page. Keep the files together: the .obj names the others.

PLY and STL write the geometry only. **Export ▸ 3D Tiles…** with the textured mesh
selected writes the mesh, with its texture, as the tile.

Mesh tools such as Smooth, Decimate or Crop produce untextured copies for now; texture
the result again if needed.
