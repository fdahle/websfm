# SAM2 smart-mask selection (F12) — model hosting & notes

**Status: shipped 2026-07-12.** The "Smart Select" tool in `MaskToolbar.vue` /
`ViewerImage.vue` uses this. Verified in-browser on onnx-community/sam2-hiera-tiny:
encoder on WebGPU, decoder on WASM (ORT's WebGPU EP crashes re-running the decoder
with a varying point count). The de-risk/harness notes below are kept for anyone
swapping the model export.

**Bundled-export fix (needed once per fresh download):** the onnx-community
`vision_encoder.onnx` / `prompt_encoder_mask_decoder.onnx` ship with broken rank-0
`value_info` on their `/conv_s0,s1/Conv` nodes, which fails ORT shape inference
(`inferred=4 declared=0`). Fix = strip all internal `value_info` (they re-infer at
load): `onnx.load(f); del m.graph.value_info[:]; onnx.save(m, f)`. Re-run this if
you re-download the models.

The compute layer for click-to-segment masking is implemented and unit-tested:

- `sam2.js` — pure preprocessing/decoding math (tested) + the ORT encoder/decoder
  glue (browser-only). Same lazy/cached/serialized session pattern as
  `core/features/lightglue.js`.
- `workers/ops/segment.js` — `segmentEncode` (once per image, caches the embedding
  worker-side) / `segmentDecode` (per click) / `segmentForget`.
- `workers/computeClient.js` — `segmentEncode` / `segmentDecode` / `segmentForget`,
  all **pinned to worker 0** (one heavy ORT session + the embedding cache live there).

## Before building the UI — DE-RISK FIRST (TODO.md F12)

The ORT glue matches decoder inputs by **name fragment** and outputs by **shape**,
because exact tensor names differ between SAM2 exports. That guessing must be
validated against one *specific* export before wiring UI. To de-risk:

1. Obtain an **image-mode** SAM2 ONNX export (two files) and drop them at:
   - `public/models/sam2_encoder.onnx`  (hiera-tiny image encoder, ~35–40 MB)
   - `public/models/sam2_decoder.onnx`  (prompt decoder, ~5–16 MB)
   Known-good sources to try: `onnx-community/sam2-hiera-tiny`,
   Meta's `segment-anything-2` exporter, or MobileSAM / SAM1 exports as a
   battle-tested browser fallback.
2. In a browser (Chrome for the WebGPU path), from the worker console or a scratch
   call, run `segmentEncode(uuid, image.computeUrl ?? image.url)` then
   `segmentDecode(uuid, [{ x, y, positive: true }])` on a known image and confirm:
   - the logged `inputs […] → outputs […]` names match what `sam2.js`'s
     `findInput` fragments expect (`point_coord`/`point_label`/`mask_input`/
     `has_mask`/`orig_im_size`) and the encoder↔decoder feature names agree
     (`image_embeddings` / `high_res_feats_0` / `high_res_feats_1`);
   - the returned mask actually covers the clicked object (verify orientation —
     if it's mirrored/transposed, that's the point-coord axis order or the
     logits row/col order, the #1 thing to fix).
3. Only once a real export round-trips correctly, build the "Smart Select" tool in
   `MaskToolbar.vue` / `ViewerImage.vue`: activating encodes (show progress),
   left-click = positive / Alt-click = negative, live preview, Enter commits the
   binary mask onto the mask canvas (modifier = subtract), covered by M2's undo.

## Known gotchas to watch for on the live run

- **Padding point**: some SAM/SAM2 ONNX decoders require a padding point
  `[0,0]` with label `-1` appended to `input_points`/`input_labels` when no box
  prompt is given, or masks come back empty. If a single click yields nothing,
  try appending that pad point in `decode()`.
- **Coord orientation**: if the mask is mirrored/transposed vs the click, flip the
  (x,y) order in `pointsToModelSpace` or the row/col order in `logitsToBinaryMask`.
- **Verified against the placed export**: `sam2_encoder.onnx` (vision_encoder,
  `pixel_values→image_embeddings/high_res_feats_0/1`) and `sam2_decoder.onnx`
  (prompt_encoder_mask_decoder, `input_points/input_labels/input_masks/
  has_input_masks → pred_masks/iou_scores`). Name matching is locked by
  `sam2.test.js` "findInput" for both these and Meta-style names.

## Contract reference

Encoder: `image [1,3,1024,1024]` (ImageNet-normalized, straight resize, no pad) →
`image_embeddings [1,256,64,64]`, `high_res_feats_0 [1,32,256,256]`,
`high_res_feats_1 [1,64,128,128]`.

Decoder: the three encoder outputs + `point_coords [1,N,2]` (1024-space px),
`point_labels [1,N]` (1=include, 0=exclude), `mask_input [1,1,256,256]` +
`has_mask_input [1]` (0 = no prior) → `masks [1,M,256,256]` logits +
`iou_predictions [1,M]`. We pick the best-IoU mask, bilinear-upsample its logits
to the original resolution, and threshold at 0.
