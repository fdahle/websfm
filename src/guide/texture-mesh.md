---
id: texture-mesh
title: Texture Mesh
summary: Paints a mesh with the photos themselves, so it shows the detail of the images rather than the colour of its vertices.
category: Products and export
order: 105
---
**Tools ▸ Mesh ▸ Texture…** paints a mesh with the photos: each triangle takes the
pixels of one photo that sees it well, stored in a [texture atlas](help:texture-atlas)
on a new mesh. Unlike vertex colour, a texture keeps the photos' detail however large
the triangles are. [Disabled](guide:getting-started) photos are never used.

## Before you run
You need a mesh in the project's frame (built, edited or imported) and the sparse
model's cameras. Texture a decimated mesh: a few hundred thousand triangles look the
same once textured and are much lighter. The workflow's **Texture Mesh** block can
decimate first (**Decimate to**).

## How it works
Each photo is checked for which triangles it really sees and how large.
[View selection](help:view-selection) picks one photo per triangle, preferring the
largest, sharpest view while keeping neighbours on the same photo, since every change
of photo is a seam. Triangles that face away from every photo are handled by **Faces no
photo sees**.

## Use masks
<!-- param: useMasks default: true -->
Leaves out the pixels [image masks](guide:masks) exclude, so people, vehicles or sky
never end up in the texture.

## Ignore what only some photos see
<!-- param: photoConsistency default: false -->
Compares the colours all photos show for each triangle and drops a photo that disagrees
with the rest: removes people and cars that moved. Needs three photos of a triangle and
one extra low-resolution read. Off by default because on a still scene it also drops
genuine view-dependent looks (reflections, foliage off a wall); turn it on for streets
and busy sites.

## Faces no photo sees
<!-- param: unseen default: Flat colour -->
**Flat colour** keeps triangles no photo sees, coloured from the vertex colours, so the
mesh stays closed. **Remove** leaves them out.

## Seam penalty
<!-- param: smoothness default: 0.5 -->
How strongly neighbouring triangles keep the same photo. Higher gives fewer seams with
slightly less direct views; **0** takes the best photo per triangle and scatters seams.

## Texture resolution
<!-- param: maxScale default: Native photo pixels -->
The finest texel size in photo pixels. **Native photo pixels** keeps all the detail; it
is lowered automatically when the atlas would exceed **Maximum pages**. The **Draft**,
**Medium** and **Full** cards set it with the page cap: a quarter of the photo pixels on
up to 2 pages, half on up to 4, native on up to 8.

## Page size
<!-- param: pageSize default: 4096 -->
The side of one atlas page. 4096 works everywhere; 8192 holds four times as much, but
some programs and older graphics cards can't show it.

## Maximum pages
<!-- param: maxPages default: 8 -->
The most atlas pages the texture may use; the resolution drops to fit. Raise it for a
large model at full detail. Each 4096 page needs about 64 MB of graphics memory.

## Level colours
<!-- param: levelColours default: true -->
Evens out brightness and white balance between photos, starting from each photo's EXIF
exposure, then smooths each chart so the two sides of every seam meet
([seam levelling](help:seam-levelling)). Turn it off only to see the photos as taken.

## Viewing and export
The 3D view shows the texture (**Colour by ▸ Texture**). **Export ▸ Mesh** keeps it in
**glTF binary (.glb)**, one file read by Blender, Cesium, Unity, Unreal and web viewers,
and **OBJ**, a .zip with the .obj, .mtl and one JPEG per page; keep them together. PLY
and STL are geometry only. **Export ▸ 3D Tiles** keeps it too
([Export 3D Tiles](guide:export-3d-tiles)).

## Mesh tools on a textured mesh
**Crop**, **Smooth** and **Clean** keep the texture, except a Clean that fills holes
(untick **Fill holes**). **Decimate** removes it, so decimate first, then texture.
**Texture** again starts afresh. **Sample to points** takes colour from the texture.
