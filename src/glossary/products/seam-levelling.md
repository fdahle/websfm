---
id: seam-levelling
title: Seam Levelling
aliases: seam levelling, seam leveling
summary: Brightening or darkening each texture chart smoothly so that the two sides of every seam between photos meet.
---
In a [textured mesh](help:texture-atlas), each chart is cut from a different photo,
and where two charts meet the photos rarely agree exactly. Light falls differently,
lenses darken towards their corners, and a camera exposes each shot on its own. Gains
per photo fix the average difference, but a seam can still show as a step.

Seam levelling (Waechter, Moehrle and Goesele, 2014) adds a correction to every chart
that varies smoothly across it. The correction is solved for the whole model at once,
so that at every seam vertex the two sides end up with the same colour, while inside a
chart neighbouring vertices change as little as possible. Deep inside a large chart the
correction fades towards the value its seams agree on, so the photo's own detail is
kept.

<!-- TODO(image): assets/seam-levelling.svg - two charts meeting at a seam, a brightness step before, the smooth ramps added on each side after. -->

Two choices keep it from doing harm. WebSfM levels **brightness only**: correcting
red, green and blue separately turned a vine chart purple where its seams met brick.
And a seam whose two sides differ a lot, which usually means misaligned detail rather
than a colour shift, pulls less. Corrections are capped at 40 grey levels. See
[Texture a Mesh](guide:texture-mesh).
