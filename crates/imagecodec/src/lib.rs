//! Native TIFF decode for the ingest pipeline.
//!
//! Replaces the pure-JS geotiff.js `readRGB` decode, which dominates TIFF ingest
//! (~34 s of ~39 s per 10137×9600 aerial scan — see TODO ▸ TC). The `tiff` crate
//! decompresses (LZW/Deflate/PackBits) in native wasm, then we resolve the
//! photometric interpretation to interleaved 8-bit **RGBA** — the exact shape the
//! JS side already packs into an `OffscreenCanvas` before its JPEG (display) +
//! lossless-PNG (compute) encodes. Output must be bit-exact with geotiff's
//! `readRGB`-then-pack path, since the PNG feeds `computeUrl` (SIFT/dense read
//! pixels back out of it, so any drift corrupts keypoints/depth).
//!
//! Exotic variants the `tiff` crate can't handle (JPEG-in-TIFF, palette, CMYK,
//! YCbCr, float) return an error so the caller falls back to geotiff.js.

use std::io::Cursor;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::ColorType;
use wasm_bindgen::prelude::*;

/// A decoded TIFF as interleaved 8-bit RGBA. `width`/`height` are plain getters;
/// `rgba()` **consumes** the handle to move the pixel buffer to JS without a copy
/// (these buffers are ~390 MB for a 97 MP image — do not clone). JS reads
/// `width`/`height` first, then calls `rgba()` last.
#[wasm_bindgen]
pub struct DecodedTiff {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedTiff {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Move the RGBA buffer out to JS (consumes `self`; the handle is freed).
    pub fn rgba(self) -> Vec<u8> {
        self.rgba
    }
}

/// Decode a TIFF byte buffer to interleaved 8-bit RGBA.
///
/// Errors (unsupported color type / bit depth, corrupt data) surface as a
/// `JsError` so the JS worker can fall back to the geotiff.js path.
#[wasm_bindgen]
pub fn decode_tiff(bytes: &[u8]) -> Result<DecodedTiff, JsError> {
    let mut decoder =
        Decoder::new(Cursor::new(bytes)).map_err(|e| JsError::new(&format!("tiff open: {e}")))?;
    let (width, height) = decoder
        .dimensions()
        .map_err(|e| JsError::new(&format!("tiff dims: {e}")))?;
    let color = decoder
        .colortype()
        .map_err(|e| JsError::new(&format!("tiff colortype: {e}")))?;
    let image = decoder
        .read_image()
        .map_err(|e| JsError::new(&format!("tiff decode: {e}")))?;

    let npx = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| JsError::new("tiff dims overflow"))?;
    let rgba = to_rgba(image, color, npx)?;

    Ok(DecodedTiff {
        width,
        height,
        rgba,
    })
}

/// Resolve a decoded sample buffer + its color type to interleaved 8-bit RGBA.
/// 16-bit sources are scaled down by `>> 8` (high byte), matching geotiff's
/// 8-bit RGB output. Anything outside the common gray/RGB(A) 8/16-bit set errors
/// so the caller falls back to geotiff.js.
fn to_rgba(image: DecodingResult, color: ColorType, npx: usize) -> Result<Vec<u8>, JsError> {
    let mut out = vec![0u8; npx * 4];
    match image {
        DecodingResult::U8(buf) => pack(&mut out, npx, color, |i| buf.get(i).copied())?,
        DecodingResult::U16(buf) => {
            pack(&mut out, npx, color, |i| buf.get(i).map(|v| (v >> 8) as u8))?
        }
        _ => return Err(JsError::new("unsupported bit depth (not 8/16-bit integer)")),
    }
    Ok(out)
}

/// Fill `out` (RGBA, `npx` pixels) by pulling samples through `get` (already
/// narrowed to u8). `get(i)` indexes the source's flat interleaved sample buffer.
fn pack<F>(out: &mut [u8], npx: usize, color: ColorType, get: F) -> Result<(), JsError>
where
    F: Fn(usize) -> Option<u8>,
{
    let need = |i: usize| get(i).ok_or_else(|| JsError::new("tiff buffer too short"));
    match color {
        ColorType::Gray(8) | ColorType::Gray(16) => {
            for p in 0..npx {
                let g = need(p)?;
                out[p * 4] = g;
                out[p * 4 + 1] = g;
                out[p * 4 + 2] = g;
                out[p * 4 + 3] = 255;
            }
        }
        ColorType::RGB(8) | ColorType::RGB(16) => {
            for p in 0..npx {
                out[p * 4] = need(p * 3)?;
                out[p * 4 + 1] = need(p * 3 + 1)?;
                out[p * 4 + 2] = need(p * 3 + 2)?;
                out[p * 4 + 3] = 255;
            }
        }
        ColorType::RGBA(8) | ColorType::RGBA(16) => {
            for p in 0..npx {
                out[p * 4] = need(p * 4)?;
                out[p * 4 + 1] = need(p * 4 + 1)?;
                out[p * 4 + 2] = need(p * 4 + 2)?;
                out[p * 4 + 3] = need(p * 4 + 3)?;
            }
        }
        ColorType::GrayA(8) | ColorType::GrayA(16) => {
            for p in 0..npx {
                let g = need(p * 2)?;
                out[p * 4] = g;
                out[p * 4 + 1] = g;
                out[p * 4 + 2] = g;
                out[p * 4 + 3] = need(p * 2 + 1)?;
            }
        }
        other => {
            return Err(JsError::new(&format!(
                "unsupported TIFF color type: {other:?}"
            )))
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tiff::encoder::{colortype, TiffEncoder};

    // Encode a tiny image with the `tiff` crate, decode it back through our
    // path, and assert the RGBA is exactly what geotiff's readRGB-then-pack
    // would produce (gray replicated to RGB, alpha 255).
    #[test]
    fn roundtrip_gray8() {
        let (w, h) = (4u32, 3u32);
        let gray: Vec<u8> = (0..(w * h) as u8).collect();
        let mut buf = Vec::new();
        {
            let mut enc = TiffEncoder::new(Cursor::new(&mut buf)).unwrap();
            enc.write_image::<colortype::Gray8>(w, h, &gray).unwrap();
        }
        let d = decode_tiff(&buf).unwrap();
        assert_eq!((d.width, d.height), (w, h));
        let rgba = d.rgba();
        for p in 0..(w * h) as usize {
            assert_eq!(&rgba[p * 4..p * 4 + 4], &[gray[p], gray[p], gray[p], 255]);
        }
    }

    #[test]
    fn roundtrip_rgb8() {
        let (w, h) = (2u32, 2u32);
        let rgb: Vec<u8> = vec![
            10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120,
        ];
        let mut buf = Vec::new();
        {
            let mut enc = TiffEncoder::new(Cursor::new(&mut buf)).unwrap();
            enc.write_image::<colortype::RGB8>(w, h, &rgb).unwrap();
        }
        let d = decode_tiff(&buf).unwrap();
        let rgba = d.rgba();
        for p in 0..(w * h) as usize {
            assert_eq!(
                &rgba[p * 4..p * 4 + 4],
                &[rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2], 255]
            );
        }
    }
}
