//! A fast, deterministic hasher for the octree's small integer keys. (Vendored patch.)
//!
//! Every hot loop of the solve — matrix assembly, right-hand side, coarse-layer
//! subtraction, marching cubes — is a stream of `HashMap<Point3<i64>, _>` lookups.
//! Upstream used std's SipHash (keyed, random per map) for most of them and byte-wise
//! FNV for the grid, both built for adversarial or arbitrary-byte input; these keys are
//! three machine words. This mixes one word at a time (FxHash's rotate-xor-multiply)
//! and finishes with a murmur3 avalanche, so the low bits hashbrown indexes buckets by
//! depend on every coordinate. Being unkeyed it is also deterministic: iteration order,
//! and so marching-cubes vertex numbering, no longer changes from run to run.

use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default, Clone, Copy)]
pub struct FastHasher(u64);

impl FastHasher {
    #[inline]
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

impl Hasher for FastHasher {
    #[inline]
    fn finish(&self) -> u64 {
        let mut h = self.0;
        h ^= h >> 33;
        h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
        h ^= h >> 33;
        h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        h ^ (h >> 33)
    }

    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut b = [0u8; 8];
            b[..chunk.len()].copy_from_slice(chunk);
            self.add(u64::from_le_bytes(b));
        }
    }

    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.add(i as u64)
    }
    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.add(i as u64)
    }
    #[inline]
    fn write_i32(&mut self, i: i32) {
        self.add(i as u32 as u64)
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.add(i)
    }
    #[inline]
    fn write_i64(&mut self, i: i64) {
        self.add(i as u64)
    }
    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.add(i as u64)
    }
}

/// `BuildHasher` for [`FastHasher`].
pub type FastState = BuildHasherDefault<FastHasher>;

/// A `HashMap` keyed with [`FastHasher`].
pub type FastMap<K, V> = std::collections::HashMap<K, V, FastState>;
