---
id: aruco-marker
title: ArUco Marker
aliases: ArUco, ArUco marker, ArUco markers, ArUco dictionary
summary: A printed square of black and white cells from one of OpenCV's dictionaries; like an AprilTag, it carries a number that software reads without help.
refs: garridojurado2014
---
An **ArUco marker** is a black square, one cell wide, around a grid of 4 × 4, 5 × 5 or
6 × 6 black and white cells, printed with white around it. The cells spell one code word
of a **dictionary**; OpenCV names them by grid and size, DICT_4X4_50 to DICT_6X6_1000,
and the smaller dictionaries are the first 50, 100 or 250 words of the 1,000. The fewer
words and the more cells, the more cells two words differ in: DICT_6X6_250 by at least
11, so up to 5 misread cells are corrected; DICT_4X4_1000 by only 2, so nothing is.

It is found and read like an [AprilTag](help:apriltag), the same idea with another code
family: its centre, where the diagonals of the black square cross, is the point to
survey.
