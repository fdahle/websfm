---
id: text-recognition
title: Text recognition (OCR)
aliases: OCR, text recognition
summary: Finding the lines of text on a photo and reading them, here to mask frame numbers, data strips and annotations on scanned film.
refs: liao2020, graves2006
---
**OCR** (optical character recognition) finds the text on an image and reads it. WebSfM
uses PaddleOCR's PP-OCRv5 mobile models in two steps:

- **Detection**: a network rates every pixel by how likely it is to lie inside a line of
  text; the regions above a threshold become boxes, turned with the text (DB, Liao et
  al., 2020).
- **Recognition**: each box is cut out upright and a second network reads it character
  by character, with a confidence for the whole line (CTC decoding, Graves et al., 2006).

On aerial film, text is printed beside the photograph (frame numbers, the camera's data
strip, a data card with dials) and sometimes on it (a mission code, the scale, a date).
Every frame carries a copy at the same place, so its features match between frames and
not with the ground. [Auto mask](guide:masks) ▸ Text masks it. The confidence of a reading
tells text from what only looks like it to the detector, such as roofs and field edges.
