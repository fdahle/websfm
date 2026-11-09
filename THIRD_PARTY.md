# Third-party code, models and data

WebSfM's own code is released under the [MIT License](LICENSE). This file lists what in
the repository, and in the app built from it, others made. Each part keeps its own
license.

## In every build: THIRD_PARTY_NOTICES.txt

`npm run build` writes `THIRD_PARTY_NOTICES.txt` (and `third-party-licenses.json`, which
the app shows in **About ▸ Licenses**) next to the app. It lists, with each license and
notice text:

- every npm package the build bundles, from the app's modules, its workers and the
  service worker;
- every Rust crate compiled into the WebAssembly modules, and the Rust standard library
  (`src/wasm/third-party.json`, written by `npm run build:wasm`);
- the entries below that no tool can find, kept in
  [`src/core/help/licenses.js`](src/core/help/licenses.js).

[`scripts/licenses/`](scripts/licenses/) builds both files. Where a package or crate
publishes no license text, [`licenses/packages/`](licenses/packages/) or
[`licenses/crates/`](licenses/crates/) supplies the upstream text: `onnxruntime-web` (its
`ThirdPartyNotices.txt` too), `@sqlite.org/sqlite-wasm`, `lerc` (with its NOTICE),
`rstar` and `wasm_sync`.

## Code taken into WebSfM's source

| Where | What | License | Text |
| --- | --- | --- | --- |
| `crates/mesh/vendor/poisson_reconstruction/` | The `poisson_reconstruction` crate 0.4.0 (Sébastien Crozet / Foresight Mining), changed: without rayon threads, with a patch to the surface level | MIT OR Apache-2.0 | `LICENSE-MIT`, `LICENSE-APACHE` in that folder |
| `src/core/sfm/tags/tag36h11.js` | The AprilTag tag36h11 codes (University of Michigan) | BSD-2-Clause | [`licenses/code/AprilTag.txt`](licenses/code/AprilTag.txt) |
| `src/core/sfm/tags/aruco.js` | OpenCV's ArUco dictionaries (`predefined_dictionaries.hpp`) | Apache-2.0 | [`licenses/code/OpenCV.txt`](licenses/code/OpenCV.txt) |
| `src/core/radiometry/micasense.js` | A port of MicaSense's `imageprocessing` radiometric model | MIT | [`licenses/code/MicaSense.txt`](licenses/code/MicaSense.txt) |

The rest of `src/` and `crates/` is WebSfM's own code. Where it implements a published
method, the paper is cited in [`src/core/help/references.js`](src/core/help/references.js)
and [docs/METHODS.md](docs/METHODS.md); methods are not copyrighted, only the code is.

## Learned models

Not in the repository. A deploy downloads them (`npm run fetch:models`) and serves them
next to the app, and the app downloads each one when first used.

| Model | From | License | Text |
| --- | --- | --- | --- |
| DISK detector | cvlab-epfl/disk, ONNX export by fabio-sim/LightGlue-ONNX | Apache-2.0 | [`DISK.txt`](licenses/models/DISK.txt), [`LightGlue-ONNX.txt`](licenses/models/LightGlue-ONNX.txt) |
| LightGlue matchers (SuperPoint, DISK) | cvg/LightGlue, ONNX export by fabio-sim/LightGlue-ONNX | Apache-2.0 | [`LightGlue.txt`](licenses/models/LightGlue.txt), [`LightGlue-ONNX.txt`](licenses/models/LightGlue-ONNX.txt) |
| ALIKED detector and its LightGlue | Shiaoming/ALIKED weights (BSD-3-Clause) through cvg/LightGlue (Apache-2.0), exported by `scripts/models/export-aliked.py` | BSD-3-Clause, Apache-2.0 | [`ALIKED.txt`](licenses/models/ALIKED.txt), [`LightGlue.txt`](licenses/models/LightGlue.txt) |
| SAM 2 (hiera-tiny) | facebookresearch/sam2, ONNX export by onnx-community on Hugging Face | Apache-2.0 | [`SAM2.txt`](licenses/models/SAM2.txt) |
| SuperPoint | magicleap/SuperPointPretrainedNetwork | Non-commercial | **Not distributed**: the user supplies the file, and a build leaves it out |

## Data

| Where | What | License |
| --- | --- | --- |
| `epsg-index` package (`all.json`) | The EPSG Geodetic Parameter Dataset, owned by IOGP | [EPSG Terms of Use](licenses/data/EPSG-terms-of-use.txt) |
| `public/geoid/` | EGM96 and EGM2008 geoid grids of the U.S. National Geospatial-Intelligence Agency, from PROJ's copies, resampled by `scripts/build-geoid-grids.mjs` | Public domain |
| Example project (downloaded, not committed) | The Aukerman photos of OpenDroneMap (`odm_data_aukerman`), 42 of 77, downscaled | CC0-1.0 ([credits](scripts/examples/aukerman-CREDITS.txt)) |
| Map backgrounds (loaded at run time, not shipped) | OpenStreetMap, Esri World Imagery, NASA GIBS | Each map shows its attribution |

## Tests, benches and docs (not in the app)

| Where | What | Source |
| --- | --- | --- |
| `tests/browser/fixtures/aukerman-4.webm` | Four Aukerman photos as a 4 s video | OpenDroneMap, CC0-1.0 |
| `tests/fixtures/metashape/` | Metashape exports of the Aukerman photos | OpenDroneMap photos (CC0-1.0); made with Agisoft Metashape |
| `src/core/lod/fixtures/tiny.copc.laz` | A synthetic point cloud | WebSfM's own (`scripts/fixtures/make-copc.py`, written by PDAL) |
| `scripts/bench/bal/ceres_bal.cc` | WebSfM's own bench program; it links Ceres Solver (BSD-3-Clause), which is not in the repository | — |
| `docs/images/` | Screenshots of WebSfM with the Aukerman project | WebSfM's own; the map background of `orthophoto.webp` is Esri World Imagery, credited under it in the README |

The icons, the favicon and the glossary's drawings were made for WebSfM.

## Adding something

A new npm package or crate needs nothing by hand: the build lists it, and warns when it
finds no license text (add it under `licenses/packages/<name>/` or
`licenses/crates/<name>/`). Code, a table, a model or data taken in by hand gets an entry
in [`src/core/help/licenses.js`](src/core/help/licenses.js) with its license text under
[`licenses/`](licenses/), and a line here.
