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
    bits_per_sample: u32,
    samples_per_pixel: u32,
    stretch_lo: i32,
    stretch_hi: i32,
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

    /// Source bit depth (1, 8 or 16), for the ingest log.
    #[wasm_bindgen(getter, js_name = bitsPerSample)]
    pub fn bits_per_sample(&self) -> u32 {
        self.bits_per_sample
    }

    /// Source samples per pixel (1 gray … 4 RGBA), for the ingest log.
    #[wasm_bindgen(getter, js_name = samplesPerPixel)]
    pub fn samples_per_pixel(&self) -> u32 {
        self.samples_per_pixel
    }

    /// The 16-bit DN mapped to 0 by the percentile stretch; −1 for an 8-bit source.
    #[wasm_bindgen(getter, js_name = stretchLo)]
    pub fn stretch_lo(&self) -> i32 {
        self.stretch_lo
    }

    /// The 16-bit DN mapped to 255 by the percentile stretch; −1 for an 8-bit source.
    #[wasm_bindgen(getter, js_name = stretchHi)]
    pub fn stretch_hi(&self) -> i32 {
        self.stretch_hi
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
    // PhotometricInterpretation 0 = WhiteIsZero. The `tiff` crate already inverts a
    // WhiteIsZero gray image while decoding; the 16-bit stretch undoes that and inverts
    // in its lookup instead, so it matches the JS fallback bit for bit.
    let white_is_zero = decoder
        .get_tag_u32(tiff::tags::Tag::PhotometricInterpretation)
        .map(|p| p == 0)
        .unwrap_or(false);
    let image = decoder
        .read_image()
        .map_err(|e| JsError::new(&format!("tiff decode: {e}")))?;

    let npx = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| JsError::new("tiff dims overflow"))?;
    let spp = samples_per_pixel(color).unwrap_or(0);
    let (rgba, bits, stretch) = to_rgba(image, color, width as usize, npx, white_is_zero)?;
    let (stretch_lo, stretch_hi) = stretch.map_or((-1, -1), |(lo, hi)| (lo as i32, hi as i32));

    Ok(DecodedTiff {
        width,
        height,
        rgba,
        bits_per_sample: bits,
        samples_per_pixel: spp as u32,
        stretch_lo,
        stretch_hi,
    })
}

/// Percentile bounds of the 16-bit stretch. MUST match `percentileRange` in
/// `src/core/io/tonalStretch.js` (the geotiff fallback path) bit for bit.
const STRETCH_LO_Q: f64 = 0.005;
const STRETCH_HI_Q: f64 = 0.995;

fn samples_per_pixel(color: ColorType) -> Option<usize> {
    match color {
        ColorType::Gray(_) => Some(1),
        ColorType::GrayA(_) => Some(2),
        ColorType::RGB(_) => Some(3),
        ColorType::RGBA(_) => Some(4),
        _ => None,
    }
}

/// Low/high percentiles of the colour samples (alpha excluded) from a 65,536-bin
/// histogram — the same targets and tie rules as tonalStretch.js `percentileRange`.
fn percentile_range(buf: &[u16], spp: usize) -> (u16, u16) {
    let colour = if spp == 2 || spp == 4 { spp - 1 } else { spp };
    let mut hist = vec![0u64; 65536];
    let mut n: u64 = 0;
    for px in buf.chunks_exact(spp) {
        for &v in &px[..colour] {
            hist[v as usize] += 1;
        }
        n += colour as u64;
    }
    if n == 0 {
        return (0, 65535);
    }
    let lo_target = (STRETCH_LO_Q * (n - 1) as f64).floor() as u64;
    let hi_target = (STRETCH_HI_Q * (n - 1) as f64).floor() as u64;
    let (mut lo, mut hi, mut acc, mut have_lo) = (0u32, 65535u32, 0u64, false);
    for v in 0..65536u32 {
        acc += hist[v as usize];
        if !have_lo && acc > lo_target {
            lo = v;
            have_lo = true;
        }
        if acc > hi_target {
            hi = v;
            break;
        }
    }
    if hi <= lo {
        lo = lo.saturating_sub(1);
        hi = (lo + 2).min(65535);
    }
    (lo as u16, hi as u16)
}

/// 16-bit → 8-bit lookup: [lo, hi] stretched linearly onto 0…255, clipped outside.
/// Same arithmetic as tonalStretch.js (f64 `(v − lo) · 255/(hi − lo)`, rounded half up).
fn stretch_lut(lo: u16, hi: u16, invert: bool) -> Vec<u8> {
    let k = 255.0 / (hi as f64 - lo as f64);
    (0..65536u32)
        .map(|v| {
            let m = if v <= lo as u32 {
                0
            } else if v >= hi as u32 {
                255
            } else {
                ((v - lo as u32) as f64 * k).round() as u8
            };
            if invert { 255 - m } else { m }
        })
        .collect()
}

/// Resolve a decoded sample buffer + its color type to interleaved 8-bit RGBA.
/// 16-bit sources are **stretched** between their 0.5 / 99.5 % levels rather than
/// cut to the high byte: a sensor that fills half its range (MicaSense pan: DN
/// ~6,300–37,000) otherwise reaches SIFT with half the contrast and ~120 grey levels.
/// Alpha is scaled by its full range. 1-bit gray (a bilevel scan or mask) unpacks to
/// 0/255. Anything outside the common gray/RGB(A) 8/16-bit set errors so the caller falls back to geotiff.js.
/// Returns (rgba, source bits, Some((lo, hi)) for a stretched source).
#[allow(clippy::type_complexity)]
fn to_rgba(
    image: DecodingResult,
    color: ColorType,
    width: usize,
    npx: usize,
    white_is_zero: bool,
) -> Result<(Vec<u8>, u32, Option<(u16, u16)>), JsError> {
    let mut out = vec![0u8; npx * 4];
    match image {
        DecodingResult::U8(buf) if color == ColorType::Gray(1) => {
            unpack_bilevel(&mut out, &buf, width)?;
            Ok((out, 1, None))
        }
        DecodingResult::U8(buf) => {
            pack(&mut out, npx, color, |i| buf.get(i).copied())?;
            Ok((out, 8, None))
        }
        DecodingResult::U16(mut buf) => {
            if white_is_zero && color == ColorType::Gray(16) {
                // Back to the file's own values (see decode_tiff); stretch_lut inverts.
                buf.iter_mut().for_each(|v| *v = 65535 - *v);
            }
            let spp = samples_per_pixel(color)
                .ok_or_else(|| JsError::new(&format!("unsupported TIFF color type: {color:?}")))?;
            let used = npx
                .checked_mul(spp)
                .filter(|&n| n <= buf.len())
                .ok_or_else(|| JsError::new("tiff buffer too short"))?;
            let (lo, hi) = percentile_range(&buf[..used], spp);
            let lut = stretch_lut(lo, hi, white_is_zero && spp <= 2);
            let has_alpha = spp == 2 || spp == 4;
            pack(&mut out, npx, color, |i| {
                buf.get(i).map(|&v| {
                    if has_alpha && i % spp == spp - 1 {
                        (v >> 8) as u8
                    } else {
                        lut[v as usize]
                    }
                })
            })?;
            Ok((out, 16, Some((lo, hi))))
        }
        _ => Err(JsError::new("unsupported bit depth (not 8/16-bit integer)")),
    }
}

/// A bilevel (1-bit) image, as CCITT Group 3/4 scans and mask files store it: rows
/// packed MSB first, each padded to a whole byte. A set bit is white (255). The
/// decoder has already inverted a WhiteIsZero file (the usual fax convention).
fn unpack_bilevel(out: &mut [u8], buf: &[u8], width: usize) -> Result<(), JsError> {
    let height = out.len() / 4 / width.max(1);
    let row_bytes = width.div_ceil(8);
    if buf.len() < row_bytes * height {
        return Err(JsError::new("tiff buffer too short"));
    }
    for y in 0..height {
        let row = &buf[y * row_bytes..(y + 1) * row_bytes];
        for x in 0..width {
            let g = if row[x >> 3] & (0x80 >> (x & 7)) != 0 { 255 } else { 0 };
            let o = (y * width + x) * 4;
            out[o] = g;
            out[o + 1] = g;
            out[o + 2] = g;
            out[o + 3] = 255;
        }
    }
    Ok(())
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

    // Parity with src/core/io/tonalStretch.test.js: the same ramp must give the same
    // percentile bounds and the same mapped values on both decode paths.
    #[test]
    fn gray16_ramp_stretch_matches_js() {
        let (w, h) = (100u32, 100u32);
        let gray: Vec<u16> = (0..(w * h) as u16).map(|i| 6000 + i * 3).collect();
        let mut buf = Vec::new();
        {
            let mut enc = TiffEncoder::new(Cursor::new(&mut buf)).unwrap();
            enc.write_image::<colortype::Gray16>(w, h, &gray).unwrap();
        }
        let d = decode_tiff(&buf).unwrap();
        assert_eq!((d.bits_per_sample, d.samples_per_pixel), (16, 1));
        assert_eq!((d.stretch_lo, d.stretch_hi), (6000 + 49 * 3, 6000 + 9949 * 3));
        let rgba = d.rgba();
        assert_eq!(rgba[0], 0); // below lo → 0
        assert_eq!(rgba[(w * h - 1) as usize * 4], 255); // above hi → 255
        // Midpoint DN 20997 (i = 4999): (20997 − 6147) · 255 / 29700 = 127.5 → 128.
        assert_eq!(&rgba[4999 * 4..4999 * 4 + 4], &[128, 128, 128, 255]);
        assert_eq!(stretch_lut(6000, 36000, false)[21000], 128); // tonalStretch.test.js
    }

    #[test]
    fn rgba16_alpha_is_scaled_not_stretched() {
        let px: Vec<u16> = vec![6000, 21000, 36000, 32768, 6000, 21000, 36000, 65535];
        let mut buf = Vec::new();
        {
            let mut enc = TiffEncoder::new(Cursor::new(&mut buf)).unwrap();
            enc.write_image::<colortype::RGBA16>(2, 1, &px).unwrap();
        }
        let d = decode_tiff(&buf).unwrap();
        assert_eq!((d.stretch_lo, d.stretch_hi), (6000, 36000));
        assert_eq!(d.rgba(), vec![0, 128, 255, 128, 0, 128, 255, 255]);
    }

    // A minimal uncompressed one-sample TIFF with any photometric interpretation (the
    // encoder writes neither 1-bit nor WhiteIsZero images): little-endian header, one
    // strip, the tags the decoder requires.
    fn gray_tiff(w: u32, h: u32, bits: u32, photometric: u16, rows: &[u8]) -> Vec<u8> {
        let tags: [(u16, u16, u32); 9] = [
            (256, 4, w),
            (257, 4, h),
            (258, 3, bits),
            (259, 3, 1),
            (262, 3, photometric as u32),
            (273, 4, 0), // strip offset, patched below
            (277, 3, 1),
            (278, 4, h),
            (279, 4, rows.len() as u32),
        ];
        let ifd_len = 2 + tags.len() * 12 + 4;
        let data_at = (8 + ifd_len) as u32;
        let mut b = vec![b'I', b'I', 42, 0, 8, 0, 0, 0];
        b.extend_from_slice(&(tags.len() as u16).to_le_bytes());
        for (tag, kind, value) in tags {
            let value = if tag == 273 { data_at } else { value };
            b.extend_from_slice(&tag.to_le_bytes());
            b.extend_from_slice(&kind.to_le_bytes());
            b.extend_from_slice(&1u32.to_le_bytes());
            if kind == 3 {
                b.extend_from_slice(&(value as u16).to_le_bytes());
                b.extend_from_slice(&[0, 0]);
            } else {
                b.extend_from_slice(&value.to_le_bytes());
            }
        }
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(rows);
        b
    }

    #[test]
    fn bilevel_unpacks_to_black_and_white() {
        // 10 × 2: rows padded to 2 bytes. Row 0 = 1000000001, row 1 = 0111111110.
        let rows = [0b1000_0000, 0b0100_0000, 0b0111_1111, 0b1000_0000];
        let gray = |rgba: &[u8]| rgba.chunks_exact(4).map(|p| p[0]).collect::<Vec<_>>();
        let d = decode_tiff(&gray_tiff(10, 2, 1, 1, &rows)).unwrap(); // BlackIsZero
        assert_eq!((d.width, d.height, d.bits_per_sample), (10, 2, 1));
        let rgba = d.rgba();
        let g = gray(&rgba);
        assert_eq!(&g[..10], &[255, 0, 0, 0, 0, 0, 0, 0, 0, 255]);
        assert_eq!(&g[10..], &[0, 255, 255, 255, 255, 255, 255, 255, 255, 0]);
        assert!(rgba.chunks_exact(4).all(|p| p[0] == p[1] && p[1] == p[2] && p[3] == 255));
        // WhiteIsZero, the fax default: a set bit is black.
        let g = gray(&decode_tiff(&gray_tiff(10, 2, 1, 0, &rows)).unwrap().rgba());
        assert_eq!(&g[..10], &[0, 255, 255, 255, 255, 255, 255, 255, 255, 0]);
    }

    // A WhiteIsZero 16-bit ramp is the BlackIsZero one inverted, with the same
    // percentile bounds: what the JS fallback (tonalStretch.js) gives. The decoder's
    // own inversion must not be applied a second time.
    #[test]
    fn gray16_white_is_zero_inverts_once() {
        let ramp: Vec<u8> = (0..400u16).flat_map(|i| (6000 + i * 70).to_le_bytes()).collect();
        let black = decode_tiff(&gray_tiff(20, 20, 16, 1, &ramp)).unwrap();
        let white = decode_tiff(&gray_tiff(20, 20, 16, 0, &ramp)).unwrap();
        assert_eq!((white.stretch_lo, white.stretch_hi), (black.stretch_lo, black.stretch_hi));
        let (b, w) = (black.rgba(), white.rgba());
        for p in 0..400 {
            assert_eq!(w[p * 4], 255 - b[p * 4], "pixel {p}");
        }
    }

    #[test]
    fn gray8_reports_no_stretch() {
        let mut buf = Vec::new();
        {
            let mut enc = TiffEncoder::new(Cursor::new(&mut buf)).unwrap();
            enc.write_image::<colortype::Gray8>(2, 1, &[3u8, 7]).unwrap();
        }
        let d = decode_tiff(&buf).unwrap();
        assert_eq!((d.bits_per_sample, d.stretch_lo, d.stretch_hi), (8, -1, -1));
    }
}
