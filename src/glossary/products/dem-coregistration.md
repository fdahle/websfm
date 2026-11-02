---
id: dem-coregistration
title: DEM Co-registration
aliases: co-registration, co-register, co-registered, Nuth & Kääb
summary: Moving one elevation model onto another, by the shift and tilt that make their stable ground agree, before they are compared.
refs: nuth2011, xdem2026
---
Two [digital elevation models](help:digital-elevation-model) of the same ground rarely
sit exactly on top of each other. Their georeferences came from different control, so
one is shifted by a few metres, raised or lowered, or tilted. On flat ground a
sideways shift does not show; on a slope it reads as height error, and on a mountain
it can be most of the difference. Co-registration finds that offset on ground that has
not changed, and removes it, so what is left is the real error, or the real change.

<!-- TODO(image): assets/dem-coregistration.svg - a slope profile of a DEM drawn a little to the right of the reference profile; the height differences are positive on one side of the ridge and negative on the other, and vanish once the DEM is moved left. -->

**Nuth & Kääb** (2011) find the horizontal shift from the slopes. A DEM displaced by a
distance *t* in a direction θ differs from its reference, on a slope of angle α
facing ψ, by about *t*·tan α·cos(ψ − θ), plus any vertical offset. Divided by tan α,
the differences follow a cosine of the slope's aspect, whose amplitude and phase are
the shift. The fit is repeated from the moved DEM until the step is small. The
vertical offset is then the median of what is left, and a tilt a plane (or a curved
surface) fitted to it.

[xDEM](https://xdem.readthedocs.io), a Python library for DEM analysis, chains these
steps the same way, and WebSfM follows its order. The comparison must be on stable
ground: rock, roads, buildings. On a glacier, the ice that thinned between the two
dates would otherwise be "corrected" away. See [Co-register DEM](guide:coregister-dem).
