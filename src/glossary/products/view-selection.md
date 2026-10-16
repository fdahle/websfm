---
id: view-selection
title: View Selection
aliases: view selection
summary: Choosing, for every triangle of a mesh, the one photo its texture comes from, trading sharpness against the number of seams.
---
Most surface in a photogrammetry project is seen by several photos, so texturing a
mesh starts with a choice: which photo should each triangle show? Taking the best photo
for each triangle on its own gives the sharpest pixels, but neighbouring triangles then
jump between photos all the time. Every jump is a seam, where a small error in the camera
positions or a difference in lighting shows as a visible step.

View selection therefore weighs two things for the whole mesh at once:

- **Quality**: how well a photo sees the triangle. WebSfM scores it by the area the
  triangle covers in the photo, in pixels. A near, square-on view covers many pixels;
  a distant or grazing one covers few. A photo in which the triangle is hidden behind
  something else, partly outside the frame or under a mask is not a candidate at all.
- **Seams**: a cost for every pair of neighbouring triangles that chose different
  photos.

$$E = \sum_{\text{triangles}} \Big(1 - \frac{\text{area}_{\text{chosen}}}{\text{area}_{\text{best}}}\Big) + \lambda \cdot \#\text{seam edges}$$

Minimising this over all triangles is a labelling problem on the mesh (a Markov random
field), solved approximately by passing messages between neighbouring triangles (loopy
belief propagation), as in Waechter, Moehrle and Goesele (2014). The weight $\lambda$ is
the **Seam penalty** setting: higher means fewer, larger charts in the
[texture atlas](help:texture-atlas).

<!-- TODO(image): assets/view-selection.svg - a mesh coloured by chosen photo: confetti with no seam penalty, large patches with it. -->

See [Texture a Mesh](guide:texture-mesh).
