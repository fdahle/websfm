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
use laz::laszip::{ChunkTable, ChunkTableEntry};
use wasm_bindgen::prelude::*;

/// The standard record length of a LAS point format, before any extra bytes.
fn base_size(point_format: u8) -> Option<u16> {
    match point_format {
        0 => Some(20),
        1 => Some(28),
        2 => Some(26),
        3 => Some(34),
        _ => None,
    }
}

/// Build the LASzip item record for a LAS point format whose records are
/// `point_size` bytes. Bytes past the format's standard record are LAS "extra
/// bytes" (core/io/las.js writes its non-standard attributes there); LASzip codes
/// them as one BYTE item, as laszip itself does. Only the formats `core/io/las.js`
/// can produce or read are accepted, and a record shorter than its format is an
/// error rather than a silent mis-decode.
fn vlr_for_format(point_format: u8, point_size: u16) -> Result<LazVlr, String> {
    let base = base_size(point_format)
        .ok_or_else(|| format!("lazcodec: unsupported LAS point format {point_format} (0-3 only)"))?;
    if point_size < base {
        return Err(format!(
            "lazcodec: point_size {point_size} is shorter than format {point_format} (at least {base})"
        ));
    }
    let mut items = LazItemRecordBuilder::new();
    items.add_item(LazItemType::Point10);
    if point_format == 1 || point_format == 3 {
        items.add_item(LazItemType::GpsTime);
    }
    if point_format == 2 || point_format == 3 {
        items.add_item(LazItemType::RGB12);
    }
    if point_size > base {
        items.add_item(LazItemType::Byte(point_size - base));
    }
    let vlr = LazVlr::from_laz_items(items.build());
    debug_assert_eq!(vlr.items_size(), u64::from(point_size));
    Ok(vlr)
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

/// The encoder's output: the first 8 bytes (the chunk-table offset, the one place
/// LASzip seeks back to and patches at the end) are kept; everything after them can
/// be drained as it is written, so a long stream never sits in wasm memory whole.
pub struct DrainSink {
    head: [u8; 8],
    body: Vec<u8>,
    base: u64, // stream position of body[0]
    pos: u64,
}

impl DrainSink {
    fn new() -> Self {
        DrainSink { head: [0; 8], body: Vec::new(), base: 8, pos: 0 }
    }

    fn drain(&mut self) -> Vec<u8> {
        self.base += self.body.len() as u64;
        std::mem::take(&mut self.body)
    }

    fn into_bytes(self) -> Vec<u8> {
        let mut out = self.head.to_vec();
        out.extend(self.body);
        out
    }
}

impl std::io::Write for DrainSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut done = 0;
        while done < buf.len() {
            let p = self.pos;
            if p < 8 {
                let n = (8 - p as usize).min(buf.len() - done);
                self.head[p as usize..p as usize + n].copy_from_slice(&buf[done..done + n]);
                done += n;
                self.pos += n as u64;
                continue;
            }
            if p < self.base || p > self.base + self.body.len() as u64 {
                return Err(std::io::Error::other("lazcodec: write into bytes already drained"));
            }
            let off = (p - self.base) as usize;
            let n = buf.len() - done;
            let overlap = (self.body.len() - off).min(n);
            self.body[off..off + overlap].copy_from_slice(&buf[done..done + overlap]);
            self.body.extend_from_slice(&buf[done + overlap..]);
            done += n;
            self.pos += n as u64;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl std::io::Seek for DrainSink {
    fn seek(&mut self, to: std::io::SeekFrom) -> std::io::Result<u64> {
        self.pos = match to {
            std::io::SeekFrom::Start(n) => n,
            std::io::SeekFrom::Current(d) => self.pos.checked_add_signed(d).ok_or_else(|| std::io::Error::other("lazcodec: seek before start"))?,
            std::io::SeekFrom::End(d) => (self.base + self.body.len() as u64).checked_add_signed(d).ok_or_else(|| std::io::Error::other("lazcodec: seek before start"))?,
        };
        Ok(self.pos)
    }
}

/// Incremental encoder: owns one continuous LASzip stream across JS chunks.
#[wasm_bindgen]
pub struct LazEncoder {
    compressor: Option<LasZipCompressor<'static, DrainSink>>,
    vlr: Vec<u8>,
    point_size: u16,
}

#[wasm_bindgen]
impl LazEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(point_format: u8, point_size: u16) -> Result<LazEncoder, JsError> {
        Self::create(point_format, point_size).map_err(|e| JsError::new(&e))
    }

    pub fn push(&mut self, points: &[u8]) -> Result<(), JsError> {
        self.push_impl(points).map_err(|e| JsError::new(&e))
    }

    /// The compressed bytes written since the last drain, past the first 8 (see
    /// DrainSink). `finish` then returns those 8 bytes followed by the rest.
    pub fn drain(&mut self) -> Result<Vec<u8>, JsError> {
        Ok(self.compressor.as_mut().ok_or_else(|| JsError::new("lazcodec: encoder already finished"))?.get_mut().drain())
    }

    pub fn finish(&mut self) -> Result<CompressedPoints, JsError> {
        self.finish_impl().map_err(|e| JsError::new(&e))
    }
}

impl LazEncoder {
    fn create(point_format: u8, point_size: u16) -> Result<Self, String> {
        let vlr = vlr_for_format(point_format, point_size)?;
        let mut bytes = Vec::new();
        vlr.write_to(&mut bytes).map_err(|e| e.to_string())?;
        let compressor = LasZipCompressor::new(DrainSink::new(), vlr)
            .map_err(|e| e.to_string())?;
        Ok(Self { compressor: Some(compressor), vlr: bytes, point_size })
    }

    fn push_impl(&mut self, points: &[u8]) -> Result<(), String> {
        if points.len() > 8 * 1024 * 1024 || points.len() % self.point_size as usize != 0 {
            return Err("lazcodec: invalid or oversized record chunk".into());
        }
        self.compressor.as_mut().ok_or("lazcodec: encoder already finished")?
            .compress_many(points).map_err(|e| e.to_string())
    }

    fn finish_impl(&mut self) -> Result<CompressedPoints, String> {
        let mut compressor = self.compressor.take().ok_or("lazcodec: encoder already finished")?;
        compressor.done().map_err(|e| e.to_string())?;
        Ok(CompressedPoints { data: compressor.into_inner().into_bytes(), vlr: std::mem::take(&mut self.vlr) })
    }
}

/// Compress raw LAS point records.
///
/// `points` is `num_points × point_size` interleaved bytes, exactly the on-disk
/// layout. `point_size` is the format's record length plus any "extra bytes", which
/// go into a LASzip BYTE item; a size *smaller* than the format requires is
/// rejected (the caller mis-sized its records).
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
    let vlr = vlr_for_format(point_format, point_size)?;
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
    let size = (num_points as usize).checked_mul(point_size as usize)
        .filter(|&n| point_size > 0 && n <= 512 * 1024 * 1024)
        .ok_or_else(|| "lazcodec: decoded records exceed the 512 MiB limit".to_string())?;
    let mut out = Vec::new();
    out.try_reserve_exact(size).map_err(|_| "lazcodec: insufficient memory".to_string())?;
    out.resize(size, 0u8);
    let mut decompressor = LasZipDecompressor::new(Cursor::new(compressed), vlr)
        .map_err(|e| format!("lazcodec: decompressor: {e}"))?;
    decompressor
        .decompress_many(&mut out)
        .map_err(|e| format!("lazcodec: decompress: {e}"))?;
    Ok(out)
}

/// Streaming decoder: a LAZ file's points a run of chunks at a time, so a file larger
/// than memory can be read (plan-lod ▸ L4). JS reads the chunk table's bytes from the
/// file and asks for each chunk's point and byte counts; it then slices a run of whole
/// chunks out of the file and decodes them here. Each LASzip chunk restarts the
/// arithmetic coder, so a chunk decodes on its own: each is wrapped as a small stream
/// (chunk-table offset, the chunk, a one-entry chunk table) and handed to the same
/// decompressor a whole file goes through.
#[wasm_bindgen]
pub struct LazDecoder {
    vlr: LazVlr,
    entries: Vec<ChunkTableEntry>,
}

#[wasm_bindgen]
impl LazDecoder {
    /// `chunk_table`: the file's bytes from the chunk table's offset on (trailing bytes
    /// such as EVLRs are ignored). Fixed-size chunks get the VLR's chunk size as their
    /// point count; the last one may hold fewer, which the caller knows from the header.
    #[wasm_bindgen(constructor)]
    pub fn new(vlr_data: &[u8], chunk_table: &[u8]) -> Result<LazDecoder, JsError> {
        LazDecoder::create(vlr_data, chunk_table).map_err(|e| JsError::new(&e))
    }

    pub fn chunk_count(&self) -> u32 {
        self.entries.len() as u32
    }

    /// Points in chunk `i` (fixed-size chunks: the nominal size).
    pub fn chunk_points(&self, i: u32) -> f64 {
        self.entries.get(i as usize).map_or(0.0, |e| e.point_count as f64)
    }

    /// Compressed bytes of chunk `i`.
    pub fn chunk_bytes(&self, i: u32) -> f64 {
        self.entries.get(i as usize).map_or(0.0, |e| e.byte_count as f64)
    }

    pub fn point_size(&self) -> u16 {
        self.vlr.items_size() as u16
    }

    /// Decode `num_points` points from the chunks `first .. first + count`, whose
    /// compressed bytes are `compressed` (back to back, as in the file).
    pub fn decode(&self, compressed: &[u8], first: u32, count: u32, num_points: u32) -> Result<Vec<u8>, JsError> {
        self.decode_impl(compressed, first, count, num_points).map_err(|e| JsError::new(&e))
    }

    /// A decoder with no chunk table, for chunks the caller locates itself: a COPC
    /// file's hierarchy gives every node's byte range and point count, and each node
    /// is one chunk (`decode_chunk`).
    #[wasm_bindgen(js_name = forChunks)]
    pub fn for_chunks(vlr_data: &[u8]) -> Result<LazDecoder, JsError> {
        let vlr = LazVlr::read_from(Cursor::new(vlr_data)).map_err(|e| JsError::new(&format!("lazcodec: vlr parse: {e}")))?;
        Ok(LazDecoder { vlr, entries: Vec::new() })
    }

    /// Decode one whole chunk of `num_points` points from its compressed bytes.
    pub fn decode_chunk(&self, compressed: &[u8], num_points: u32) -> Result<Vec<u8>, JsError> {
        self.decode_chunk_impl(compressed, num_points).map_err(|e| JsError::new(&e))
    }
}

impl LazDecoder {
    fn create(vlr_data: &[u8], chunk_table: &[u8]) -> Result<LazDecoder, String> {
        let vlr = LazVlr::read_from(Cursor::new(vlr_data)).map_err(|e| format!("lazcodec: vlr parse: {e}"))?;
        // The VLR payload starts with the compressor type: 1 = one unchunked stream.
        if vlr_data.len() >= 2 && u16::from_le_bytes([vlr_data[0], vlr_data[1]]) == 1 {
            return Err("lazcodec: this LAZ file is not chunked, so it cannot be read in parts".to_string());
        }
        let variable = vlr.uses_variable_size_chunks();
        let table = ChunkTable::read(&mut Cursor::new(chunk_table), variable)
            .map_err(|e| format!("lazcodec: chunk table: {e}"))?;
        let entries = table
            .as_ref()
            .iter()
            .map(|e| ChunkTableEntry {
                point_count: if variable { e.point_count } else { u64::from(vlr.chunk_size()) },
                byte_count: e.byte_count,
            })
            .collect();
        Ok(LazDecoder { vlr, entries })
    }

    fn decode_impl(&self, compressed: &[u8], first: u32, count: u32, num_points: u32) -> Result<Vec<u8>, String> {
        let (first, count) = (first as usize, count as usize);
        let run = self
            .entries
            .get(first..first + count)
            .ok_or_else(|| "lazcodec: chunk range outside the table".to_string())?;
        let bytes: u64 = run.iter().map(|e| e.byte_count).sum();
        if bytes != compressed.len() as u64 {
            return Err(format!("lazcodec: expected {bytes} compressed bytes, got {}", compressed.len()));
        }
        let point_size = self.vlr.items_size() as usize;
        let mut out = self.records(num_points)?;
        // One decompressor per chunk, each started at its own bytes: decoding several
        // chunks in sequence assumes each ends exactly where the next begins, and not
        // every writer's chunks do (the table, not the coder, says where they start).
        let (mut at, mut done) = (0usize, 0usize);
        for e in run {
            let n = (e.point_count as usize).min(num_points as usize - done);
            if n == 0 {
                break;
            }
            let bytes = &compressed[at..at + e.byte_count as usize];
            self.decode_one(bytes, *e, &mut out[done * point_size..(done + n) * point_size])?;
            at += e.byte_count as usize;
            done += n;
        }
        if done != num_points as usize {
            return Err(format!("lazcodec: the chunks hold {done} points, not {num_points}"));
        }
        Ok(out)
    }

    fn decode_chunk_impl(&self, compressed: &[u8], num_points: u32) -> Result<Vec<u8>, String> {
        let mut out = self.records(num_points)?;
        if num_points > 0 {
            let entry = ChunkTableEntry { point_count: u64::from(num_points), byte_count: compressed.len() as u64 };
            self.decode_one(compressed, entry, &mut out)?;
        }
        Ok(out)
    }

    // Zeroed room for `num_points` records, within the 512 MiB limit.
    fn records(&self, num_points: u32) -> Result<Vec<u8>, String> {
        let size = (num_points as usize)
            .checked_mul(self.vlr.items_size() as usize)
            .filter(|&n| n <= 512 * 1024 * 1024)
            .ok_or_else(|| "lazcodec: decoded records exceed the 512 MiB limit".to_string())?;
        let mut out = Vec::new();
        out.try_reserve_exact(size).map_err(|_| "lazcodec: insufficient memory".to_string())?;
        out.resize(size, 0u8);
        Ok(out)
    }

    // One chunk into `out` (whole records). Each LASzip chunk restarts the coder, so it
    // is wrapped as a small stream ([i64 offset of the table][the chunk][a table of just
    // this chunk]) and handed to the decompressor a whole file goes through.
    fn decode_one(&self, bytes: &[u8], entry: ChunkTableEntry, out: &mut [u8]) -> Result<(), String> {
        let mut stream = Vec::with_capacity(8 + bytes.len() + 32);
        stream.extend_from_slice(&((8 + bytes.len()) as i64).to_le_bytes());
        stream.extend_from_slice(bytes);
        let mut table = ChunkTable::with_capacity(1);
        table.push(entry);
        table.write_to(&mut stream, &self.vlr).map_err(|e| format!("lazcodec: chunk table: {e}"))?;
        let mut decompressor = LasZipDecompressor::new(Cursor::new(stream), self.vlr.clone())
            .map_err(|e| format!("lazcodec: decompressor: {e}"))?;
        decompressor.decompress_many(out).map_err(|e| format!("lazcodec: decompress: {e}"))
    }
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

    #[test]
    fn incremental_encoder_round_trips_across_chunks() {
        let points = make_points(120_003);
        let mut encoder = LazEncoder::create(2, 26).unwrap();
        for chunk in points.chunks(26 * 50_000) { encoder.push_impl(chunk).unwrap(); }
        let packed = encoder.finish_impl().unwrap();
        let decoded = decompress_points_impl(&packed.vlr, &packed.data, 120_003, 26).unwrap();
        assert_eq!(decoded, points);
        assert!(encoder.finish_impl().is_err());
    }

    // Drained as it goes, the stream is the same bytes as kept whole.
    #[test]
    fn drained_encoder_writes_the_same_stream() {
        let points = make_points(170_001);
        let mut whole = LazEncoder::create(2, 26).unwrap();
        let mut drained = LazEncoder::create(2, 26).unwrap();
        let mut parts = Vec::new();
        for chunk in points.chunks(26 * 30_000) {
            whole.push_impl(chunk).unwrap();
            drained.push_impl(chunk).unwrap();
            parts.extend(drained.compressor.as_mut().unwrap().get_mut().drain());
        }
        let a = whole.finish_impl().unwrap().data;
        let b = drained.finish_impl().unwrap().data;
        let mut joined = b[..8].to_vec();
        joined.extend(parts);
        joined.extend(&b[8..]);
        assert_eq!(joined, a);
    }

    // A file's points decoded a run of chunks at a time equal the whole decode.
    #[test]
    fn streaming_decoder_reads_runs_of_chunks() {
        let n = 230_017usize; // 5 chunks of 50 000, the last partial
        let points = make_points(n);
        let packed = compress_points_impl(&points, 2, 26).unwrap();
        let data = &packed.data;
        let table_at = i64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
        let decoder = LazDecoder::create(&packed.vlr, &data[table_at..]).unwrap();
        assert_eq!(decoder.chunk_count(), 5);
        let mut at = 8usize;
        let mut decoded = Vec::new();
        let mut first = 0u32;
        for run in [2u32, 1, 2] {
            let bytes: usize = (first..first + run).map(|i| decoder.chunk_bytes(i) as usize).sum();
            let points_in: usize = (first..first + run)
                .map(|i| (decoder.chunk_points(i) as usize).min(n - 50_000 * i as usize))
                .sum();
            decoded.extend(decoder.decode_impl(&data[at..at + bytes], first, run, points_in as u32).unwrap());
            at += bytes;
            first += run;
        }
        assert_eq!(decoded, points);
        assert!(decoder.decode_impl(&data[8..9], 0, 1, 1).is_err());
    }

    // Against a real file (LAZ_FILE=path): chunk-wise decoding equals the library's
    // own sequential decoding of the whole point block.
    #[test]
    #[ignore]
    fn streaming_matches_sequential_on_a_real_file() {
        use std::io::{Read, Seek, SeekFrom};
        let path = std::env::var("LAZ_FILE").expect("LAZ_FILE");
        let mut f = std::fs::File::open(&path).unwrap();
        let mut head = vec![0u8; 4096];
        f.read_exact(&mut head).unwrap();
        let offset_to_points = u32::from_le_bytes(head[96..100].try_into().unwrap()) as u64;
        let header_size = u16::from_le_bytes(head[94..96].try_into().unwrap()) as usize;
        let n_vlrs = u32::from_le_bytes(head[100..104].try_into().unwrap());
        let mut vp = header_size;
        let mut vlr_data = Vec::new();
        for _ in 0..n_vlrs {
            let rid = u16::from_le_bytes(head[vp + 18..vp + 20].try_into().unwrap());
            let len = u16::from_le_bytes(head[vp + 20..vp + 22].try_into().unwrap()) as usize;
            if rid == 22204 { vlr_data = head[vp + 54..vp + 54 + len].to_vec(); }
            vp += 54 + len;
        }
        let vlr = LazVlr::read_from(Cursor::new(&vlr_data)).unwrap();
        let ps = vlr.items_size() as usize;
        let n = 150_000usize;
        f.seek(SeekFrom::Start(offset_to_points)).unwrap();
        let mut seq = vec![0u8; n * ps];
        LasZipDecompressor::new(&mut f, vlr.clone()).unwrap().decompress_many(&mut seq).unwrap();
        let mut ptr = [0u8; 8];
        f.seek(SeekFrom::Start(offset_to_points)).unwrap();
        f.read_exact(&mut ptr).unwrap();
        let table_at = i64::from_le_bytes(ptr) as u64;
        let mut table = Vec::new();
        f.seek(SeekFrom::Start(table_at)).unwrap();
        f.read_to_end(&mut table).unwrap();
        let d = LazDecoder::create(&vlr_data, &table).unwrap();
        let bytes: usize = (0..3).map(|i| d.chunk_bytes(i) as usize).sum();
        let mut comp = vec![0u8; bytes];
        f.seek(SeekFrom::Start(offset_to_points + 8)).unwrap();
        f.read_exact(&mut comp).unwrap();
        let ours = d.decode_impl(&comp, 0, 3, n as u32).unwrap();
        let first = (0..n * ps).find(|&i| ours[i] != seq[i]);
        assert_eq!(first, None, "first difference at byte {first:?} (record {:?})", first.map(|b| b / ps));
        // A chunk decoded alone equals the same chunk in sequence.
        let (b0, b1) = (d.chunk_bytes(0) as usize, d.chunk_bytes(1) as usize);
        let alone = d.decode_impl(&comp[b0..b0 + b1], 1, 1, 50_000).unwrap();
        assert_eq!(&alone[..], &seq[50_000 * ps..100_000 * ps]);
    }

    // COPC: every node is one chunk, located by the hierarchy rather than a table.
    #[test]
    fn chunk_decoder_reads_one_chunk_without_a_table() {
        let n = 120_000usize; // chunks of 50 000, 50 000, 20 000
        let points = make_points(n);
        let packed = compress_points_impl(&points, 2, 26).unwrap();
        let data = &packed.data;
        let table_at = i64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
        let table = LazDecoder::create(&packed.vlr, &data[table_at..]).unwrap();
        let (b0, b1) = (table.chunk_bytes(0) as usize, table.chunk_bytes(1) as usize);
        let chunks = LazDecoder { vlr: LazVlr::read_from(Cursor::new(&packed.vlr)).unwrap(), entries: Vec::new() };
        let second = chunks.decode_chunk_impl(&data[8 + b0..8 + b0 + b1], 50_000).unwrap();
        assert_eq!(&second[..], &points[50_000 * 26..100_000 * 26]);
        let last = chunks.decode_chunk_impl(&data[8 + b0 + b1..table_at], 20_000).unwrap();
        assert_eq!(&last[..], &points[100_000 * 26..]);
        assert!(chunks.decode_chunk_impl(&[], 0).unwrap().is_empty());
    }

    // The LAS 1.4 layered coder (point formats 6-8, what COPC uses), variable chunks.
    #[test]
    fn chunk_decoder_reads_layered_point_format_7() {
        use laz::las::laszip::LazVlrBuilder;
        let items = LazItemRecordBuilder::default_for_point_format_id(7, 0).unwrap();
        let vlr = LazVlrBuilder::new(items).with_variable_chunk_size().build();
        let size = vlr.items_size() as usize;
        assert_eq!(size, 36);
        let mut points = vec![0u8; 3000 * size];
        for (i, p) in points.chunks_mut(size).enumerate() {
            p[0..4].copy_from_slice(&(i as i32 * 17).to_le_bytes());
            p[4..8].copy_from_slice(&(i as i32 * -5).to_le_bytes());
            p[8..12].copy_from_slice(&(i as i32 % 97).to_le_bytes());
            p[14] = 0x11; // return 1 of 1
            p[16] = (i % 7) as u8; // classification
            p[30..36].copy_from_slice(&[(i % 251) as u8, 0, 7, 0, 9, 0]);
        }
        let mut out = Cursor::new(Vec::new());
        let mut compressor = LasZipCompressor::new(&mut out, vlr.clone()).unwrap();
        compressor.compress_many(&points[..1000 * size]).unwrap();
        compressor.finish_current_chunk().unwrap();
        compressor.compress_many(&points[1000 * size..]).unwrap();
        compressor.done().unwrap();
        drop(compressor);
        let data = out.into_inner();
        let table_at = i64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
        let mut vlr_bytes = Vec::new();
        vlr.write_to(&mut vlr_bytes).unwrap();
        let table = LazDecoder::create(&vlr_bytes, &data[table_at..]).unwrap();
        assert_eq!((table.chunk_points(0), table.chunk_points(1)), (1000.0, 2000.0));
        let b0 = table.chunk_bytes(0) as usize;
        let chunks = LazDecoder { vlr: LazVlr::read_from(Cursor::new(&vlr_bytes)).unwrap(), entries: Vec::new() };
        assert_eq!(chunks.decode_chunk_impl(&data[8 + b0..table_at], 2000).unwrap(), &points[1000 * size..]);
        assert_eq!(chunks.decode_chunk_impl(&data[8..8 + b0], 1000).unwrap(), &points[..1000 * size]);
    }

    #[test]
    fn rejects_oversized_decompression_before_allocating() {
        let packed = compress_points_impl(&make_points(1), 2, 26).unwrap();
        let error = decompress_points_impl(&packed.vlr, &packed.data, u32::MAX, 26).unwrap_err();
        assert!(error.contains("limit"));
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
        assert!(LazEncoder::create(2, 25).is_err());
    }

    // Records of `base` bytes from make_points-like data with `extra` bytes appended
    // (an f32 and odd bytes, so the BYTE item sees both smooth and noisy values).
    fn with_extra_bytes(n: usize, extra: usize) -> Vec<u8> {
        let base = make_points(n);
        let mut v = Vec::with_capacity(n * (26 + extra));
        for i in 0..n {
            v.extend_from_slice(&base[i * 26..(i + 1) * 26]);
            let f = (i as f32 * 0.37).sin().to_le_bytes();
            for k in 0..extra {
                v.push(if k < 4 { f[k] } else { (i * 31 + k * 7) as u8 });
            }
        }
        v
    }

    // Extra bytes ride along as a BYTE item: whole, incremental and chunk-wise decoding
    // all give the records back, and the VLR's item list says so.
    #[test]
    fn round_trips_extra_bytes() {
        for extra in [1usize, 6, 13] {
            let size = (26 + extra) as u16;
            let points = with_extra_bytes(120_007, extra);
            let packed = compress_points_impl(&points, 2, size).unwrap();
            let vlr = LazVlr::read_from(Cursor::new(&packed.vlr)).unwrap();
            assert_eq!(vlr.items_size(), u64::from(size));
            assert!(vlr.items().iter().any(|it| it.item_type() == LazItemType::Byte(extra as u16)));
            let back = decompress_points_impl(&packed.vlr, &packed.data, 120_007, size).unwrap();
            assert_eq!(back, points, "whole decode, {extra} extra bytes");

            let mut encoder = LazEncoder::create(2, size).unwrap();
            for chunk in points.chunks(size as usize * 40_000) { encoder.push_impl(chunk).unwrap(); }
            let inc = encoder.finish_impl().unwrap();
            assert_eq!(inc.data, packed.data);

            let table_at = i64::from_le_bytes(packed.data[0..8].try_into().unwrap()) as usize;
            let decoder = LazDecoder::create(&packed.vlr, &packed.data[table_at..]).unwrap();
            assert_eq!(decoder.point_size(), size);
            let bytes: usize = (0..decoder.chunk_count()).map(|i| decoder.chunk_bytes(i) as usize).sum();
            let streamed = decoder.decode_impl(&packed.data[8..8 + bytes], 0, decoder.chunk_count(), 120_007).unwrap();
            assert_eq!(streamed, points, "chunk-wise decode, {extra} extra bytes");
        }
    }

    // Format 3 (GPS time) with extra bytes after the RGB.
    #[test]
    fn round_trips_format_3_with_extra_bytes() {
        let n = 5_000;
        let base = make_points(n); // Point10 + RGB, split around the GPS time
        let mut points = Vec::with_capacity(n * 38);
        for i in 0..n {
            let r = &base[i * 26..(i + 1) * 26];
            points.extend_from_slice(&r[..20]);
            points.extend_from_slice(&(i as f64 * 0.01).to_le_bytes());
            points.extend_from_slice(&r[20..26]);
            points.extend_from_slice(&(i as u32).to_le_bytes());
        }
        let packed = compress_points_impl(&points, 3, 38).unwrap();
        assert_eq!(decompress_points_impl(&packed.vlr, &packed.data, n as u32, 38).unwrap(), points);
    }

    #[test]
    fn rejects_an_unsupported_format() {
        assert!(compress_points_impl(&make_points(1), 6, 30).is_err());
    }
}
