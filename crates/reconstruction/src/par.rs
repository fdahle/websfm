// Data parallelism for the bundle adjustment, with one code path for both builds.
//
// The threaded build (`--features threads`: wasm atomics + shared memory, a rayon pool
// started from JS by `initThreadPool`, see lib.rs) runs `for_each_index` on the pool;
// the default build runs the same calls in a loop. Callers split their work so the
// result does not depend on how many threads ran it: every output element has exactly
// one writer, and every sum is taken in a fixed order (see bundle.rs, the Schur step).

/// `f(i)` for every i in 0..n, on the thread pool when there is one.
#[cfg(feature = "threads")]
pub(crate) fn for_each_index<F: Fn(usize) + Sync + Send>(n: usize, f: F) {
    use rayon::prelude::*;
    (0..n).into_par_iter().for_each(f);
}

/// `f(i)` for every i in 0..n, on the thread pool when there is one.
#[cfg(not(feature = "threads"))]
pub(crate) fn for_each_index<F: Fn(usize)>(n: usize, f: F) {
    for i in 0..n { f(i) }
}

/// A raw pointer that may cross threads. Whoever writes through it must make sure no
/// two threads touch the same element (the callers give every element one owner).
pub(crate) struct SyncPtr<T>(pub *mut T);
impl<T> Clone for SyncPtr<T> { fn clone(&self) -> Self { *self } }
impl<T> Copy for SyncPtr<T> {}
unsafe impl<T> Send for SyncPtr<T> {}
unsafe impl<T> Sync for SyncPtr<T> {}
impl<T> SyncPtr<T> {
    pub(crate) fn of(v: &mut [T]) -> Self { SyncPtr(v.as_mut_ptr()) }
    /// # Safety
    /// `i` is in bounds and no other thread accesses element `i` meanwhile.
    #[inline(always)]
    pub(crate) unsafe fn at<'a>(self, i: usize) -> &'a mut T { &mut *self.0.add(i) }
    /// # Safety
    /// `i..i + len` is in bounds and no other thread accesses it meanwhile.
    #[inline(always)]
    pub(crate) unsafe fn slice<'a>(self, i: usize, len: usize) -> &'a mut [T] { std::slice::from_raw_parts_mut(self.0.add(i), len) }
}

/// Items per task for the per-observation and per-point loops: big enough that the pool's
/// overhead does not show, small enough to balance.
pub(crate) const CHUNK: usize = 4096;

/// [f(0), …, f(n−1)], computed on the pool when there is one. A caller that sums the
/// result in index order gets the bits of a plain loop.
pub(crate) fn map_indexed<T: Clone + Default + Send, F: Fn(usize) -> T + Sync + Send>(n: usize, f: F) -> Vec<T> {
    let mut out = vec![T::default(); n];
    let p = SyncPtr::of(&mut out);
    for_each_index(n.div_ceil(CHUNK), |k| {
        // SAFETY: chunk k alone writes indices k·CHUNK … (k+1)·CHUNK − 1.
        for i in k * CHUNK..((k + 1) * CHUNK).min(n) { unsafe { *p.at(i) = f(i); } }
    });
    out
}
