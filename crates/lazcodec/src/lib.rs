//! LASzip (LAZ) compression for point-cloud export/import.
//!
//! websfm writes LAS 1.2 point format 2 (`core/io/las.js`). LAZ is the same data
//! run through LASzip's arithmetic coder — typically 5–10× smaller — and is what
//! CloudCompare, QGIS, ArcGIS and every survey package actually expect. There is
//! no credible pure-JS LAZ *writer*, hence this crate.
//!
//! Division of labour: **JS owns the LAS header and the VLRs** (`core/io/laz.js`
//! reuses the header writer that LAS export already has); this crate only does
//! the chunked arithmetic coding of the point records, plus the LASzip VLR
//! payload that describes how they were coded. That keeps the format knowledge in
//! one place instead of splitting it across a language boundary.
//!
//! Point records are passed as raw interleaved bytes (`num_points ×
//! point_size`), the same layout they have on disk, so nothing is transposed or
//! re-boxed on the way through — a 30 M-point cloud must never become a list of
//! objects.

use std::io::Cursor;

use laz::las::laszip::{LasZipCompressor, LasZipDecompressor, LazItemRecordBuilder, LazItemType, LazVlr};
use wasm_bindgen::prelude::*;

/// Build the LASzip item record for a LAS point format. Only the formats
/// `core/io/las.js` can produce or read are accepted; anything else is an error
/// rather than a silent mis-decode.
fn vlr_for_format(point_format: u8) -> Result<LazVlr, String> {
    let mut items = LazItemRecordBuilder::new();
    match point_format {
        0 => {
            items.add_item(LazItemType::Point10);
        }
        1 => {
            items.add_item(LazItemType::Point10);
            items.add_item(LazItemType::GpsTime);
        }
        2 => {
            items.add_item(LazItemType::Point10);
            items.add_item(LazItemType::RGB12);
        }
        3 => {
            items.add_item(LazItemType::Point10);
            items.add_item(LazItemType::GpsTime);
            items.add_item(LazItemType::RGB12);
        }
        _ => {
            return Err(format!(
                "lazcodec: unsupported LAS point format {point_format} (0-3 only)"
            ))
        }
    }
    Ok(LazVlr::from_laz_items(items.build()))
}

/// Compressed points plus the LASzip VLR payload that describes them. Both are
/// moved out to JS by value (`data()` / `vlr()` consume nothing but clone the
/// smaller VLR; `data()` takes the big buffer).
#[wasm_bindgen]
pub struct CompressedPoints {
    data: Vec<u8>,
    vlr: Vec<u8>,
}

#[wasm_bindgen]
impl CompressedPoints {
    /// The LASzip VLR record payload — JS writes it into the LAS header's VLR
    /// area as user id "laszip encoded", record id 22204.
    #[wasm_bindgen(getter)]
    pub fn vlr(&self) -> Vec<u8> {
        self.vlr.clone()
    }

    /// Move the compressed point block out to JS (consumes the handle).
    pub fn data(self) -> Vec<u8> {
        self.data
    }
}

/// Compress raw LAS point records.
///
/// `points` is `num_points × point_size` interleaved bytes, exactly the on-disk
/// layout. `point_size` must match the format's record length (the caller may add
/// "extra bytes", which LASzip carries verbatim — but we reject a size *smaller*
/// than the format requires, which would mean the caller mis-sized its records).
#[wasm_bindgen]
pub fn compress_points(
    points: &[u8],
    point_format: u8,
    point_size: u16,
) -> Result<CompressedPoints, JsError> {
    compress_points_impl(points, point_format, point_size).map_err(|e| JsError::new(&e))
}

fn compress_points_impl(
    points: &[u8],
    point_format: u8,
    point_size: u16,
) -> Result<CompressedPoints, String> {
    let vlr = vlr_for_format(point_format)?;
    let expected = vlr.items_size() as u16;
    if point_size != expected {
        return Err(format!(
            "lazcodec: point_size {point_size} does not match format {point_format} (expected {expected})"
        ));
    }
    if points.len() % point_size as usize != 0 {
        return Err(format!(
            "lazcodec: point buffer {} is not a multiple of the {point_size}-byte record",
            points.len()
        ));
    }

    let mut vlr_bytes = Vec::new();
    vlr.write_to(&mut vlr_bytes)
        .map_err(|e| format!("lazcodec: vlr write: {e}"))?;

    let mut out = Cursor::new(Vec::<u8>::new());
    {
        let mut compressor = LasZipCompressor::new(&mut out, vlr)
            .map_err(|e| format!("lazcodec: compressor: {e}"))?;
        compressor
            .compress_many(points)
            .map_err(|e| format!("lazcodec: compress: {e}"))?;
        // `done` flushes the final chunk AND back-patches the chunk-table offset
        // written at the head of the block — skipping it yields a file whose
        // points decode until the last chunk and then fail.
        compressor
            .done()
            .map_err(|e| format!("lazcodec: finish: {e}"))?;
    }

    Ok(CompressedPoints {
        data: out.into_inner(),
        vlr: vlr_bytes,
    })
}

/// Decompress a LAZ point block back to raw LAS point records.
///
/// `vlr_data` is the LASzip VLR payload read from the file — **not** reconstructed
/// from the point format. A LAZ file records its own chunking and item layout
/// there, and assuming ours would mis-decode anything another writer produced.
#[wasm_bindgen]
pub fn decompress_points(
    vlr_data: &[u8],
    compressed: &[u8],
    num_points: u32,
    point_size: u16,
) -> Result<Vec<u8>, JsError> {
    decompress_points_impl(vlr_data, compressed, num_points, point_size).map_err(|e| JsError::new(&e))
}

fn decompress_points_impl(
    vlr_data: &[u8],
    compressed: &[u8],
    num_points: u32,
    point_size: u16,
) -> Result<Vec<u8>, String> {
    let vlr = LazVlr::read_from(Cursor::new(vlr_data))
        .map_err(|e| format!("lazcodec: vlr parse: {e}"))?;
    let expected = vlr.items_size() as u16;
    if point_size != expected {
        return Err(format!(
            "lazcodec: point_size {point_size} does not match the file's LASzip VLR ({expected})"
        ));
    }
    let mut out = vec![0u8; num_points as usize * point_size as usize];
    let mut decompressor = LasZipDecompressor::new(Cursor::new(compressed), vlr)
        .map_err(|e| format!("lazcodec: decompressor: {e}"))?;
    decompressor
        .decompress_many(&mut out)
        .map_err(|e| format!("lazcodec: decompress: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Point format 2: 20-byte Point10 + 6-byte RGB.
    fn make_points(n: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(n * 26);
        for i in 0..n {
            let x = (i as i32) * 137 - 5000;
            let y = (i as i32) * -91 + 2000;
            let z = (i as i32) * 13;
            v.extend_from_slice(&x.to_le_bytes());
            v.extend_from_slice(&y.to_le_bytes());
            v.extend_from_slice(&z.to_le_bytes());
            v.extend_from_slice(&((i % 65535) as u16).to_le_bytes()); // intensity
            v.push(1); // return/number-of-returns bits
            v.push(0); // classification
            v.push(0); // scan angle rank
            v.push(0); // user data
            v.extend_from_slice(&0u16.to_le_bytes()); // point source id
            v.extend_from_slice(&((i * 7 % 65535) as u16).to_le_bytes()); // R
            v.extend_from_slice(&((i * 11 % 65535) as u16).to_le_bytes()); // G
            v.extend_from_slice(&((i * 13 % 65535) as u16).to_le_bytes()); // B
        }
        assert_eq!(v.len(), n * 26);
        v
    }

    // The invariant the whole crate exists for. It also covers the chunk-table
    // back-patch: at 200k points the block spans several chunks, so a missing
    // `done()` would fail here and not on a toy input.
    #[test]
    fn round_trips_point_format_2() {
        for n in [1usize, 1000, 200_000] {
            let points = make_points(n);
            let packed = compress_points_impl(&points, 2, 26).unwrap();
            let back = decompress_points_impl(&packed.vlr, &packed.data, n as u32, 26).unwrap();
            assert_eq!(back, points, "round trip failed for {n} points");
        }
    }

    #[test]
    fn compresses_meaningfully() {
        let points = make_points(50_000);
        let packed = compress_points_impl(&points, 2, 26).unwrap();
        assert!(
            packed.data.len() < points.len() / 2,
            "expected >2x compression, got {} from {}",
            packed.data.len(),
            points.len()
        );
    }

    #[test]
    fn rejects_a_mismatched_record_size() {
        let points = make_points(10);
        assert!(compress_points_impl(&points, 2, 20).is_err());
    }

    #[test]
    fn rejects_an_unsupported_format() {
        assert!(compress_points_impl(&make_points(1), 6, 30).is_err());
    }
}
