---
id: dem-of-difference
title: DEM of Difference
aliases: DEM of difference, DEMs of difference, DoD
summary: The height difference between two elevation models of the same ground, and the volume of material gained or lost between them.
---
Subtract one [digital elevation model](help:digital-elevation-model) from another
of the same area, cell by cell, and what is left is change: a stockpile that grew,
a slope that slid, a riverbank that eroded. Summed over an area, the differences
times the cell area give the **volume** gained (where the newer surface lies higher)
and lost (where it lies lower).

<!-- TODO(image): assets/dem-of-difference.svg - two terrain profiles of one slope at two dates, the area between them shaded blue where material was added and red where it was removed. -->

Two things decide whether the numbers mean anything. The two models must be in the
same coordinate system and [vertical datum](help:vertical-datum): a geoid offset
between them shows up as a uniform "change" over the whole area. WebSfM converts the
reference into the DEM's datum when both declare ellipsoidal, EGM96 or EGM2008
heights. And their difference has an uncertainty of its
own, the combined vertical error of both models; a change smaller than that is
noise. Comparing the two DEMs on stable ground first (Evaluate ▸ DEM vs Reference)
shows both the offset and the noise level.

In WebSfM, the **Volume** tool on the computed DEM can take an imported reference DEM
as its base, so the result is gain, loss and net change inside a polygon. Without one,
the global background terrain (about 30 m cells) can be the base: enough to see a
large change or an offset of the whole DEM, not a small one. See
[Build a DEM](guide:dem).
