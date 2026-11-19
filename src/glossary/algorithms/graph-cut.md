---
id: graph-cut
title: Graph Cut
aliases: graph cuts, graph-cut, min cut, minimum cut, min-cut, alpha-expansion, alpha expansion
summary: Choosing a label for every pixel at once by cutting a graph at its cheapest point, so that each pixel's own preference and the cost of disagreeing with its neighbours are traded off together.
refs: boykov2001, boykov2004
---
Many image problems ask for one **label** per pixel: which photo colours this part of
an [orthophoto](help:orthophoto), which side of an object a pixel is on. Each pixel
has its own preference (a cost per label), and neighbouring pixels should usually
agree, with a cost wherever they do not. Choosing pixel by pixel ignores the second
part; a **graph cut** finds the labelling with the lowest total cost.

For two labels the problem is a network: one node per pixel, joined to its four
neighbours by edges that cost what a disagreement there would cost, and to two
terminals, one per label, by edges that cost the pixel's preference. Splitting the
network in two so that each terminal keeps its side is a **cut**, and the cost of the
cheapest cut, the **minimum cut**, equals the maximum flow that can pass from one
terminal to the other (Ford and Fulkerson). WebSfM computes it with the
Boykov–Kolmogorov algorithm, which is fast on image grids.

![A 4 × 4 grid of pixel nodes between two terminals, A above and B below. Grey edges join neighbours, thicker where disagreeing costs more; gold and blue edges join each pixel to the terminals by its preference. A red staircase line, the minimum cut, follows the weakest grey edges and splits the pixels into an A group and a B group.](assets/graph-cut.svg)

With more than two labels, **alpha-expansion** (Boykov, Veksler and Zabih, 2001)
repeats two-label cuts: for each label in turn, one cut decides which pixels switch to
it and which keep the label they have. Each accepted move lowers the total cost, and a
few rounds over all labels reach a labelling close to the best one.

For orthophoto [seamlines](help:seamline) the labels are the photos. A pixel prefers
the photo that looks most straight down on it, and a seam between two photos costs
their colour difference there, so the cheapest labelling puts the seams where the
photos agree: along open ground, around buildings and trees. See
[Build Orthophoto](guide:orthophoto).
