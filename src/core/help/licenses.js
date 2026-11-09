// Acknowledgments and the hand-kept part of the third-party notices.
//
//  1. ACKNOWLEDGMENTS: credit for the ideas and prior art WebSfM is built on (COLMAP,
//     PatchMatch stereo, screened Poisson, Metashape …). Not a legal requirement.
//
//  2. INCLUDED: what others made that WebSfM ships and no tool can find: code and tables
//     taken into WebSfM's own source, the learned models and the data. The npm packages
//     the build bundles and the Rust crates in the WebAssembly modules are listed by the
//     build itself (scripts/licenses/), with their license texts; the build adds these
//     entries and writes both to third-party-licenses.json (About ▸ Licenses) and
//     THIRD_PARTY_NOTICES.txt, which ship with the app.
//
// Taking in someone else's code, table, model or data by hand means an entry here, its
// license text under licenses/ (`textFiles`, repo-relative) and a line in THIRD_PARTY.md.
// A package or crate that publishes no license text gets one in licenses/packages/<name>/
// or licenses/crates/<name>/. Pure data: imported by the About dialog and by the build.

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
      'Meshing follows Kazhdan & Hoppe’s screened-Poisson method, through the Rust ' +
      'poisson_reconstruction crate (see Licenses).',
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
 * Third-party components no tool can list, grouped. Each item:
 *   { name, version?, license (SPDX where there is one), url, use?, notice?, textFiles? }
 * `name` is what a user knows it by; `use` says in a few words what WebSfM uses it for;
 * `notice` is an attribution shown in full; `textFiles` are the license or terms texts
 * (repo-relative paths under licenses/), which the build copies into the notices.
 * `models` (learned models only) names the core/models/registry.js ids the entry covers.
 */
export const INCLUDED = [
  {
    group: 'Code and tables in WebSfM’s own source',
    items: [
      {
        // core/sfm/tags/tag36h11.js
        name: 'AprilTag',
        version: '3',
        license: 'BSD-2-Clause',
        url: 'https://github.com/AprilRobotics/apriltag',
        use: 'The tag36h11 codes, for Detect Targets',
        textFiles: ['licenses/code/AprilTag.txt'],
      },
      {
        // core/sfm/tags/aruco.js, from modules/objdetect/src/aruco/predefined_dictionaries.hpp
        name: 'OpenCV ArUco dictionaries',
        version: '4.x',
        license: 'Apache-2.0',
        url: 'https://github.com/opencv/opencv',
        use: 'The DICT_4X4, DICT_5X5 and DICT_6X6 codes, for Detect Targets',
        notice: 'Copyright (C) 2000-2022, Intel Corporation, all rights reserved; and others.',
        textFiles: ['licenses/code/OpenCV.txt'],
      },
      {
        // core/radiometry/micasense.js
        name: 'MicaSense imageprocessing',
        version: '2024',
        license: 'MIT',
        url: 'https://github.com/micasense/imageprocessing',
        use: 'The radiometric model for MicaSense multispectral cameras',
        textFiles: ['licenses/code/MicaSense.txt'],
      },
    ],
  },
  {
    // Downloaded on demand with consent (stores/useModelsStore.js); the download prompt
    // shows each license too (core/models/registry.js). SuperPoint is not distributed:
    // its pretrained weights carry Magic Leap's non-commercial license, so the user
    // supplies the file.
    group: 'Learned models (downloaded when first used)',
    items: [
      {
        name: 'SuperPoint',
        license: 'Non-commercial (Magic Leap)',
        url: 'https://github.com/magicleap/SuperPointPretrainedNetwork',
        use: 'Not distributed: you supply the weights file yourself',
        models: ['superpoint'],
      },
      {
        name: 'LightGlue',
        license: 'Apache-2.0',
        url: 'https://github.com/cvg/LightGlue',
        use: 'The LightGlue matchers, and the ALIKED network code WebSfM exported',
        models: ['lightglue', 'lightglue_disk', 'lightglue_aliked', 'aliked'],
        textFiles: ['licenses/models/LightGlue.txt'],
      },
      {
        name: 'LightGlue-ONNX',
        license: 'Apache-2.0',
        url: 'https://github.com/fabio-sim/LightGlue-ONNX',
        use: 'The ONNX exports of DISK and of LightGlue for SuperPoint and DISK',
        models: ['disk', 'lightglue', 'lightglue_disk'],
        textFiles: ['licenses/models/LightGlue-ONNX.txt'],
      },
      {
        name: 'DISK',
        license: 'Apache-2.0',
        url: 'https://github.com/cvlab-epfl/disk',
        use: 'The DISK feature detector weights',
        models: ['disk'],
        textFiles: ['licenses/models/DISK.txt'],
      },
      {
        name: 'ALIKED',
        license: 'BSD-3-Clause',
        url: 'https://github.com/Shiaoming/ALIKED',
        use: 'The ALIKED feature detector weights (aliked-n16)',
        models: ['aliked'],
        textFiles: ['licenses/models/ALIKED.txt'],
      },
      {
        name: 'SAM 2',
        license: 'Apache-2.0',
        url: 'https://github.com/facebookresearch/sam2',
        use: 'Auto mask (sam2-hiera-tiny, as exported to ONNX by onnx-community on Hugging Face)',
        models: ['sam2_encoder', 'sam2_decoder'],
        textFiles: ['licenses/models/SAM2.txt'],
      },
    ],
  },
  {
    group: 'Data',
    items: [
      {
        // epsg-index/all.json, the CRS catalog (core/crsRegistry.js)
        name: 'EPSG Geodetic Parameter Dataset',
        license: 'EPSG Terms of Use',
        url: 'https://epsg.org',
        use: 'The coordinate reference systems you can pick (through the epsg-index package)',
        notice:
          'The EPSG Geodetic Parameter Dataset is owned by IOGP (International Association of Oil & Gas Producers).',
        textFiles: ['licenses/data/EPSG-terms-of-use.txt'],
      },
      {
        // public/geoid/, made by scripts/build-geoid-grids.mjs
        name: 'EGM96 and EGM2008 geoid models',
        license: 'Public domain',
        url: 'https://cdn.proj.org',
        use: 'Heights above the geoid (vertical datums)',
        notice:
          'Resampled to a 15′ grid from the U.S. National Geospatial-Intelligence Agency’s ' +
          'EGM96 and EGM2008 models, as PROJ distributes them.',
      },
      // The example projects' photos (core/examples.js), downloaded when one is opened.
      // CC0 asks for nothing, but the people who flew and shared them are credited here,
      // in the project picker and in each download's CREDITS.txt.
      ...Object.values(EXAMPLES).map((e) => ({
        name: `${e.title} photos`,
        license: e.licenseId,
        url: e.sourceUrl,
        use: `${e.credit} · ${e.dataset}`,
        notice: `Thank you to ${e.credit} for sharing these photos. WebSfM uses ${e.changes}.`,
      })),
    ],
  },
]

/**
 * Notes and links the build adds to generated entries: a vendored crate says what
 * WebSfM changed in its copy (crates/<crate>/vendor/).
 */
export const CRATE_NOTES = {
  poisson_reconstruction: {
    url: 'https://github.com/fslabs/PoissonReconstruction',
    use: 'Mesh reconstruction',
    notice: 'WebSfM ships a changed copy: without threads, and with a patch to the surface level.',
  },
}
