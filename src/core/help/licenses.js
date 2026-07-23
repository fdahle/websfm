// Attribution + third-party license manifest — the SINGLE home for both.
//
// Two distinct things live here, because they answer to different rules:
//
//  1. ACKNOWLEDGMENTS — courtesy credit for the *ideas* and prior art websfm is
//     built on (COLMAP, PatchMatch stereo, screened-Poisson, Metashape, …).
//     Not a legal requirement; it's simply the right thing to do.
//
//  2. THIRD_PARTY — the code / weights actually *shipped* to the user's browser.
//     Permissive licenses (MIT / BSD / Apache-2.0) require the copyright +
//     permission notice to travel with the distribution, and a browser app IS
//     distribution. So every bundled dependency (JS deps, the Rust crates
//     compiled into WASM, and the downloadable ONNX models) must appear below.
//
// MAINTENANCE DIRECTIVE (mirrored in CLAUDE.md): whenever you add a dependency
// whose license requires its notice to be shown — any bundled npm package, any
// crate compiled into a WASM module (including vendored code under
// `crates/*/vendor/`), or a downloadable model weight — add an entry here with
// its real SPDX id and upstream URL. For a strong-copyleft or attribution-heavy
// license, paste the full notice text into the entry's `notice` field. The About
// modal renders this list; there is no build-time scanner, so this file is the
// source of truth and going stale means shipping an incomplete notice.

/** Pure-credit acknowledgments — prior art / architectural inspiration. */
export const ACKNOWLEDGMENTS = [
  {
    name: 'COLMAP',
    url: 'https://colmap.github.io/',
    note: 'The incremental Structure-from-Motion structure (next-best-view registration, ' +
      'two-gate PnP, interleaved bundle adjustment) and the cross-view depth-consistency ' +
      'fusion filter in the dense pipeline follow COLMAP’s design.',
  },
  {
    name: 'PatchMatch Stereo / Gipuma',
    url: 'https://github.com/kysucix/gipuma',
    note: 'The dense multi-view stereo uses slanted-plane PatchMatch with red–black ' +
      'checkerboard propagation, after Bleyer et al. and Galliani et al.',
  },
  {
    name: 'Screened Poisson Surface Reconstruction',
    url: 'https://www.cs.jhu.edu/~misha/Code/PoissonRecon/',
    note: 'Meshing follows Kazhdan & Hoppe’s screened-Poisson method, via Dimforge’s ' +
      'Rust implementation (see below).',
  },
  {
    name: 'SIFT (D. Lowe)',
    url: 'https://www.cs.ubc.ca/~lowe/keypoints/',
    note: 'The default feature detector implements the Scale-Invariant Feature Transform.',
  },
  {
    name: 'Agisoft Metashape',
    url: 'https://www.agisoft.com/',
    note: 'General photogrammetry workflow and UI conventions took inspiration from ' +
      'established desktop tools such as Metashape.',
  },
]

/**
 * Bundled third-party components, grouped by where they run. Each entry:
 *   { name, version, license (SPDX), url, notice? }
 * `notice` is the full text to reproduce verbatim when a license demands it;
 * omit it for permissive licenses covered by name + upstream link.
 */
export const THIRD_PARTY = [
  {
    group: 'Application (JavaScript)',
    items: [
      { name: 'Vue',                    version: '3.5.38',  license: 'MIT',          url: 'https://github.com/vuejs/core' },
      { name: 'Pinia',                  version: '3.0.4',   license: 'MIT',          url: 'https://github.com/vuejs/pinia' },
      { name: 'OpenLayers',             version: '10.9.0',  license: 'BSD-2-Clause', url: 'https://github.com/openlayers/openlayers' },
      { name: 'Three.js',               version: '0.171.0', license: 'MIT',          url: 'https://github.com/mrdoob/three.js' },
      { name: 'proj4js',                version: '2.20.9',  license: 'MIT',          url: 'https://github.com/proj4js/proj4js' },
      { name: 'geotiff.js',             version: '3.0.5',   license: 'MIT',          url: 'https://github.com/geotiffjs/geotiff.js' },
      { name: 'ONNX Runtime Web',       version: '1.27.0',  license: 'MIT',          url: 'https://github.com/microsoft/onnxruntime' },
      { name: 'KaTeX',                  version: '0.17.0',  license: 'MIT',          url: 'https://github.com/KaTeX/KaTeX' },
      { name: 'marked',                 version: '18.0.5',  license: 'MIT',          url: 'https://github.com/markedjs/marked' },
      { name: 'marked-katex-extension', version: '5.1.10',  license: 'MIT',          url: 'https://github.com/UziTech/marked-katex-extension' },
      { name: 'exifr',                  version: '7.1.3',   license: 'MIT',          url: 'https://github.com/MikeKovarik/exifr' },
      { name: 'fflate',                 version: '0.8.3',   license: 'MIT',          url: 'https://github.com/101arrowz/fflate' },
    ],
  },
  {
    group: 'Compute (Rust → WASM)',
    items: [
      { name: 'wasm-bindgen',            version: '0.2.125', license: 'MIT OR Apache-2.0', url: 'https://github.com/rustwasm/wasm-bindgen' },
      { name: 'nalgebra',                version: '0.33.3',  license: 'Apache-2.0',        url: 'https://github.com/dimforge/nalgebra' },
      { name: 'tiff',                    version: '0.9.1',   license: 'MIT',               url: 'https://github.com/image-rs/image-tiff' },
      { name: 'poisson_reconstruction',  version: '0.4.0',   license: 'MIT OR Apache-2.0', url: 'https://github.com/dimforge/poisson_reconstruction',
        notice: 'Vendored under crates/mesh/vendor/ (rayon stripped for threadless WASM, ' +
          'with a marching-cubes iso patch).' },
    ],
  },
  {
    // Downloaded on demand with consent (see stores/useModelsStore.js). Licenses
    // are shown at the download prompt too. VERIFY each weight’s provenance:
    // some SuperPoint ONNX conversions are research/non-commercial only.
    group: 'Learned models (downloaded on demand)',
    items: [
      { name: 'SuperPoint', license: 'MIT', url: 'https://github.com/rpautrat/SuperPoint'},
      { name: 'LightGlue', license: 'Apache-2.0', url: 'https://github.com/cvg/LightGlue' },
      { name: 'SAM 2',     license: 'Apache-2.0', url: 'https://github.com/facebookresearch/sam2' },
    ],
  },
]
