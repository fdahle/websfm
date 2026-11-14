---
id: image-retrieval
title: Image Retrieval
aliases: image retrieval, VLAD, similar images, visual similarity
summary: Finding which photos look alike from their features alone, before matching any pair, so a large unordered set is matched only where photos probably overlap.
refs: jegou2010, arandjelovic2013
---
**Image retrieval** ranks a set of photos by how alike they look, the way a search engine
finds similar pictures. WebSfM uses it to choose the pairs to match (Match Features ▸
Pairing ▸ **Similar images**) when there are too many photos to match every pair and no
camera positions to [preselect](help:preselection) by.

Each photo's [keypoint](help:keypoint) descriptors are summarised in one fixed-length
vector, **VLAD** (vector of locally aggregated descriptors). A small vocabulary of 64
"visual words" is learned from descriptors sampled across the project's own photos; every
descriptor is assigned to its nearest word, and the differences between descriptors and
their words are summed per word. Each word's share is normalised to the same length, so a
facade full of identical windows does not outvote everything else in the photo. Two photos
whose vectors point the same way probably show the same place.

Each photo is then paired with its most similar photos. Retrieval only proposes pairs:
every pair is still matched and checked with [RANSAC](help:ransac), so a wrong guess costs
time, never accuracy. What it can miss is a pair that overlaps but looks different, such
as two views of a building from very different angles; more similar images per photo
widen the net.

Unlike Sequential pairing, retrieval finds a second pass over the same place: the photos
of both laps look alike, whatever their capture order.
