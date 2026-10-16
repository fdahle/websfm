---
id: texture-atlas
title: Texture Atlas
aliases: texture atlas, texture atlases, atlas page, atlas pages, UV coordinates, textured mesh, textured meshes
summary: The images that hold a mesh's texture, with every triangle's corners pinned to a spot on them by UV coordinates.
---
A textured [mesh](help:mesh) carries its colour in images rather than in its
vertices. Each triangle corner gets two extra numbers, its **UV coordinates**, which say
where on an image that corner sits; the graphics card stretches the image region between
a triangle's three UVs across the triangle. Because the image has its own resolution,
a large triangle can still show fine detail, which a colour per vertex cannot.

A whole model rarely fits in one picture, so the texture is an **atlas**: many pieces,
called charts, packed side by side onto one or more square pages. A chart is a patch of
connected triangles that share one stretch of image. Between charts the UVs jump, and
the vertices on that border are stored twice, once for each chart.

<!-- TODO(image): assets/texture-atlas.svg - a small textured box on the left; on the right one atlas page with its charts (top, sides) packed as rectangles, one triangle's three UVs marked on both. -->

How the charts are made differs between programs. A general unwrapper cuts the
surface into pieces that lie flat with little distortion and then paints them. WebSfM,
like most photogrammetry software, lets the photos decide: a chart is a group of
triangles that took the same photo in [view selection](help:view-selection), and its UVs
are simply where its corners appear in that photo. The chart is then a rectangle cut out
of the photo, so the texture is the photo's own pixels.

Each chart keeps a margin of a few pixels of real image around it. Graphics cards blend
neighbouring pixels when they shrink a texture for distant viewing, and without the
margin the chart's edge would pick up the colour of whatever was packed next to it.

Formats: glTF/GLB embeds the pages in the file; OBJ refers to them from a separate
material (MTL) file. See [Texture a Mesh](guide:texture-mesh).
