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

import { EXAMPLES } from '../examples.js'

/** Pure-credit acknowledgments — prior art / architectural inspiration. */
export const ACKNOWLEDGMENTS = [
  {
    name: 'COLMAP',
    url: 'https://colmap.github.io/',
    note:
      'The incremental Structure-from-Motion structure (next-best-view registration, ' +
      'two-gate PnP, interleaved bundle adjustment) and the cross-view depth-consistency ' +
      'fusion filter in the dense pipeline follow COLMAP’s design.',
  },
  {
    name: 'PatchMatch Stereo / Gipuma',
    url: 'https://github.com/kysucix/gipuma',
    note:
      'The dense multi-view stereo uses slanted-plane PatchMatch with red–black ' +
      'checkerboard propagation, after Bleyer et al. and Galliani et al.',
  },
  {
    name: 'Screened Poisson Surface Reconstruction',
    url: 'https://www.cs.jhu.edu/~misha/Code/PoissonRecon/',
    note:
      'Meshing follows Kazhdan & Hoppe’s screened-Poisson method, via Dimforge’s ' + 'Rust implementation (see below).',
  },
  {
    name: 'SIFT (D. Lowe)',
    url: 'https://www.cs.ubc.ca/~lowe/keypoints/',
    note: 'The default feature detector implements the Scale-Invariant Feature Transform.',
  },
  {
    name: 'Agisoft Metashape',
    url: 'https://www.agisoft.com/',
    note:
      'General photogrammetry workflow and UI conventions took inspiration from ' +
      'established desktop tools such as Metashape.',
  },
]

/**
 * Bundled third-party components, grouped by where they run. Each entry:
 *   { name, version, license (SPDX), url, use?, notice?, text? }
 * `name` is what a user knows it by (no source paths); `use` says in a few words
 * what WebSfM uses it for; `notice` is a short attribution shown in full; `text`
 * is a license or copyright text reproduced verbatim when the license demands it,
 * folded under "License text" in the About dialog. Omit `text` for permissive
 * licenses covered by name + upstream link.
 */
export const THIRD_PARTY = [
  {
    group: 'Application (JavaScript)',
    items: [
      { name: 'Vue', version: '3.5.38', license: 'MIT', url: 'https://github.com/vuejs/core' },
      { name: 'Pinia', version: '3.0.4', license: 'MIT', url: 'https://github.com/vuejs/pinia' },
      {
        name: 'OpenLayers',
        version: '10.9.0',
        license: 'BSD-2-Clause',
        url: 'https://github.com/openlayers/openlayers',
      },
      { name: 'Three.js', version: '0.171.0', license: 'MIT', url: 'https://github.com/mrdoob/three.js' },
      { name: 'proj4js', version: '2.20.9', license: 'MIT', url: 'https://github.com/proj4js/proj4js' },
      { name: 'geotiff.js', version: '3.0.5', license: 'MIT', url: 'https://github.com/geotiffjs/geotiff.js' },
      { name: 'ONNX Runtime Web', version: '1.27.0', license: 'MIT', url: 'https://github.com/microsoft/onnxruntime' },
      { name: 'KaTeX', version: '0.17.0', license: 'MIT', url: 'https://github.com/KaTeX/KaTeX' },
      { name: 'marked', version: '18.0.5', license: 'MIT', url: 'https://github.com/markedjs/marked' },
      {
        name: 'marked-katex-extension',
        version: '5.1.10',
        license: 'MIT',
        url: 'https://github.com/UziTech/marked-katex-extension',
      },
      { name: 'exifr', version: '7.1.3', license: 'MIT', url: 'https://github.com/MikeKovarik/exifr' },
      { name: 'fflate', version: '0.8.3', license: 'MIT', url: 'https://github.com/101arrowz/fflate' },
      { name: 'SQLite Wasm', version: '3.53.0', license: 'Apache-2.0', url: 'https://github.com/sqlite/sqlite-wasm' },
      { name: 'Delaunator', version: '5.0.1', license: 'ISC', url: 'https://github.com/mapbox/delaunator' },
      {
        name: 'robust-predicates',
        version: '3.0.3',
        license: 'Unlicense',
        url: 'https://github.com/mourner/robust-predicates',
      },
      {
        // core/sfm/tags/tag36h11.js
        name: 'AprilTag',
        version: '3',
        license: 'BSD-2-Clause',
        url: 'https://github.com/AprilRobotics/apriltag',
        use: 'Tag family 36h11, for Detect Targets',
        text:
          'Copyright (C) 2013-2016, The Regents of The University of Michigan. All rights reserved.\n' +
          'Redistribution and use in source and binary forms, with or without modification, are permitted ' +
          'provided that the following conditions are met:\n' +
          '1. Redistributions of source code must retain the above copyright notice, this list of conditions ' +
          'and the following disclaimer.\n' +
          '2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions ' +
          'and the following disclaimer in the documentation and/or other materials provided with the ' +
          'distribution.\n' +
          'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR ' +
          'IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND ' +
          'FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR ' +
          'CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL ' +
          'DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, ' +
          'DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER ' +
          'IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT ' +
          'OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
      },
      {
        // core/sfm/tags/aruco.js, from modules/objdetect/src/aruco/predefined_dictionaries.hpp
        name: 'OpenCV ArUco dictionaries',
        version: '4.x',
        license: 'Apache-2.0',
        url: 'https://github.com/opencv/opencv',
        use: 'DICT_4X4, DICT_5X5 and DICT_6X6, for Detect Targets',
        text:
          'Copyright (C) 2000-2022, Intel Corporation, all rights reserved; and others.\n' +
          'Licensed under the Apache License, Version 2.0; a copy is at ' +
          'https://www.apache.org/licenses/LICENSE-2.0',
      },
      {
        // core/radiometry/micasense.js
        name: 'MicaSense imageprocessing',
        version: '2024',
        license: 'MIT',
        url: 'https://github.com/micasense/imageprocessing',
        use: 'Radiometric model for multispectral cameras',
        text:
          'Copyright (c) 2017 MicaSense, Inc.\n' +
          'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and ' +
          'associated documentation files (the "Software"), to deal in the Software without restriction, ' +
          'including without limitation the rights to use, copy, modify, merge, publish, distribute, ' +
          'sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is ' +
          'furnished to do so, subject to the following conditions:\n' +
          'The above copyright notice and this permission notice shall be included in all copies or ' +
          'substantial portions of the Software.\n' +
          'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT ' +
          'NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND ' +
          'NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, ' +
          'DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT ' +
          'OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
      },
    ],
  },
  {
    group: 'Compute (Rust → WASM)',
    items: [
      {
        name: 'wasm-bindgen',
        version: '0.2.125',
        license: 'MIT OR Apache-2.0',
        url: 'https://github.com/rustwasm/wasm-bindgen',
      },
      { name: 'nalgebra', version: '0.33.3', license: 'Apache-2.0', url: 'https://github.com/dimforge/nalgebra' },
      { name: 'tiff', version: '0.9.1', license: 'MIT', url: 'https://github.com/image-rs/image-tiff' },
      {
        name: 'poisson_reconstruction',
        version: '0.4.0',
        license: 'MIT OR Apache-2.0',
        url: 'https://github.com/dimforge/poisson_reconstruction',
        // Vendored under crates/mesh/vendor/ (rayon stripped, marching-cubes iso patch).
        use: 'Mesh reconstruction',
        notice: 'WebSfM ships a modified copy: without threads, and with a patch to the surface level.',
      },
      {
        name: 'laz',
        version: '0.12.2',
        license: 'Apache-2.0',
        url: 'https://github.com/laz-rs/laz-rs',
        // Compiled into crates/lazcodec.
        use: 'LAZ point-cloud compression (a Rust port of LASzip)',
        text: 'Licensed under the Apache License, Version 2.0; a copy is at https://www.apache.org/licenses/LICENSE-2.0',
      },
      {
        name: 'byteorder',
        version: '1.5.0',
        license: 'Unlicense OR MIT',
        url: 'https://github.com/BurntSushi/byteorder',
      },
      {
        name: 'num-traits',
        version: '0.2.19',
        license: 'MIT OR Apache-2.0',
        url: 'https://github.com/rust-num/num-traits',
      },
    ],
  },
  {
    // Downloaded on demand with consent (see stores/useModelsStore.js). Licenses
    // are shown at the download prompt too and must match core/models/registry.js.
    // SuperPoint is NOT distributed by websfm: its pretrained weights carry Magic
    // Leap's non-commercial license, so the user supplies the file themselves.
    group: 'Learned models (downloaded on demand)',
    items: [
      {
        name: 'SuperPoint',
        license: 'Non-commercial (Magic Leap)',
        url: 'https://github.com/magicleap/SuperPointPretrainedNetwork',
        use: 'Not distributed: you supply the weights file yourself',
      },
      { name: 'DISK', license: 'Apache-2.0', url: 'https://github.com/cvlab-epfl/disk' },
      { name: 'ALIKED', license: 'BSD-3-Clause', url: 'https://github.com/Shiaoming/ALIKED' },
      { name: 'LightGlue', license: 'Apache-2.0', url: 'https://github.com/cvg/LightGlue' },
      {
        name: 'LightGlue-ONNX',
        use: 'ONNX exports of LightGlue',
        license: 'Apache-2.0',
        url: 'https://github.com/fabio-sim/LightGlue-ONNX',
      },
      { name: 'SAM 2', license: 'Apache-2.0', url: 'https://github.com/facebookresearch/sam2' },
    ],
  },
  {
    // The example projects' photos (core/examples.js), downloaded when one is opened.
    // CC0 asks for nothing, but the people who flew and shared them are credited here,
    // in the project picker and in each download's CREDITS.txt.
    group: 'Example data',
    items: Object.values(EXAMPLES).map((e) => ({
      name: `${e.title} photos`,
      license: e.licenseId,
      url: e.sourceUrl,
      use: `${e.credit} · ${e.dataset}`,
      notice: `Thank you to ${e.credit} for sharing these photos. WebSfM uses ${e.changes}.`,
    })),
  },
]
