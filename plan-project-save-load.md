# Plan — project save/load (.websfm file) + folder-backed storage

Two features, one enabling fact: the per-project OPFS directory
(`websfm/projects/{id}/…`) is **already a self-contained, file-based project
format** — `project.json` + `images/` + `images-derived/` + keypoint/descriptor
bins + `matches/` + `depthmaps/` + `gcps/sensors/poses/reconstruction` JSONs +
`products/` + `log.ndjson`. Everything goes through `utils/opfs.js` (the only
module touching `navigator.storage` besides the app-global proj4 cache in
`core/crs.js` and a quota readout in AboutModal). So:

- **Save/Load** = zip / unzip that directory tree. No new format to invent.
- **Folder-backed projects** = swap the root `FileSystemDirectoryHandle`.
  OPFS handles and `showDirectoryPicker()` handles expose the *identical*
  async API (`getDirectoryHandle` / `getFileHandle` / `createWritable` /
  `removeEntry`), so all ~70 helpers in opfs.js work unchanged on a real
  disk folder. This is exactly the draw.io pattern (File System Access API).

Phase 1 is standalone and low-risk; Phase 2 builds on a small refactor; do them
in order.

---

## Phase 1 — Save / load a project file (`.websfm`)

**Format**: a plain zip with extension `.websfm`, containing the project dir
verbatim plus a root `manifest.json`:
`{ format: 'websfm-project', version: 1, exportedAt, appVersion, project: {name, sceneType, crs, createdAt} }`.
Being "just a zip" is a feature — inspectable, future-proof, and identical to
what a Phase-2 folder project looks like on disk.

**What to include / exclude**
- Include: everything under the project dir. Original images are the bulk;
  they must be included (source of truth). `images-derived/` and `depthmaps/`
  are large but expensive to recompute — include by default, offer an
  "exclude cached/derived data (smaller file)" checkbox that skips
  `images-derived/`, `depthmaps/`, `products/` (restore already heals all
  three: derived blobs re-transcode on miss, depth maps just absent, products
  regenerate).
- Exclude always: `log.ndjson` (session record, not project data).

**Library**: `fflate` (new dep, ~8 kB, streaming, worker-safe). Compression
per entry: level 0 (store) for `.bin`/images/blobs (already compressed or
incompressible float data), deflate for JSON.

**Export flow** (`useProjectsStore.exportProject(id, opts)`)
1. New opfs.js helper `walkProjectFiles(projectId)` — async iterator of
   `{ relPath, file }` over the project dir (recursive).
2. Stream entries into `fflate.Zip`. Target: `showSaveFilePicker()` writable
   when available (constant memory, works for multi-GB projects); fallback
   (Firefox/Safari): accumulate a Blob and `<a download>` it, with a size
   warning above ~1 GB.
3. Main thread is fine — fflate compresses in chunks between awaited OPFS
   reads; if jank shows up, move the loop into a `workers/ops/io.js` op
   (workers can open OPFS and receive directory handles) — but don't start
   there.
4. UI: Ribbon ▸ File/Other → "Save project as…". Log per-section byte counts
   (heavy-logging convention).

**Import flow** (`useProjectsStore.importProject(file)`)
1. Sniff: zip magic `PK` + `manifest.json` with `format:'websfm-project'`;
   register in `core/io/importKind.js` and route through `useImportRouting`
   so dropping a `.websfm` on the window works too.
2. Validate `version` (reject newer-than-known with a clear message).
3. Unzip streaming into a **fresh** `crypto.randomUUID()` project dir via the
   existing write helpers. Internal image/pair uuids are project-scoped —
   no id rewriting needed. Name from manifest, suffix "(imported)" on clash.
4. Add index entry, `switchProject` to it. The normal restore path handles
   everything else, including healing any excluded derived data.

**Tests**: round-trip a small synthetic project (export → import → deep-compare
project.json / gcps / reconstruction JSONs + bin byte-equality); manifest
version reject; "exclude derived" produces a loadable project. The zip walk
itself needs a browser run (OPFS) — say so, per the verification convention.

---

## Phase 2 — Folder-backed projects (draw.io style)

**Feasibility**: yes, but Chromium-only (`showDirectoryPicker` — Chrome/Edge/
Opera; not Firefox, not Safari). Feature-detect and hide the option elsewhere;
OPFS stays the default and the fallback. Disk writes are slightly slower than
OPFS (safe-browsing scan on `writable.close()`), irrelevant at our write sizes.

**Core refactor — pluggable project root** (the only structural change)
- opfs.js: `getProjectDir(projectId)` currently resolves
  `OPFS/websfm/projects/{id}`. Add a module-level registry
  `setProjectRoot(projectId, dirHandle)` / `clearProjectRoot(id)`;
  `getProjectDir` returns the registered handle when present, else the OPFS
  path. Every other helper is untouched. The project-list `index.json` always
  stays in OPFS.
- Handle persistence: `FileSystemDirectoryHandle` is structured-cloneable →
  store in a tiny IndexedDB (`utils/handleStore.js`, one object store keyed by
  projectId). localStorage cannot hold handles.
- Index entry gains `storage: 'opfs' | 'folder'` (absent ⇒ opfs, back-compat).

**Open/reconnect flow** (the fiddly part — permissions)
- On `switchProject` of a folder project: load handle from IDB →
  `queryPermission({mode:'readwrite'})`. If `'granted'`, register root and
  restore normally. Else show a blocking "Reconnect folder" prompt —
  `requestPermission` needs a user gesture, so it must be a button, not
  automatic. If the handle is dead (folder moved/deleted), offer re-pick
  (`showDirectoryPicker`) or "forget project".
- Chromium persists permission grants across sessions for regularly-used
  sites, so in practice the prompt appears rarely.

**Layout on disk**: byte-identical to the OPFS layout. Load-bearing decision:
it means (a) the Phase-1 zip export/import works verbatim on folder projects,
(b) migration is a plain tree copy, (c) one restore path, zero format drift.
Human-friendly filenames (extensions on image blobs, original names) are a
possible v2, but they'd fork the layout — park it.

**UI**
- New-project modal: storage choice "In browser (default)" / "In a folder…"
  (picker button, Chromium-gated). Folder flow: pick dir → require empty or
  confirm → register root → create as today.
- Project list: badge folder projects with their path
  (`handle.name`; full path isn't exposed — that's a platform limit).
- Migration both ways: "Move to folder…" / "Move into browser storage" =
  `walkProjectFiles` copy → flip `storage` + register/clear root → delete the
  source tree (after verified copy).
- "Open folder as project": pick a dir that already contains a
  `project.json` → adopt it (new index entry, keep its ids). This gives
  Dropbox/git-style sharing of live projects for free.

**Gotchas to encode**
- All persistence already runs on the main thread (stores own it; the worker
  is pure compute) — no worker handle-passing needed. If Phase 1 moved
  zipping into a worker, post the handle (handles clone across postMessage).
- `crs.js` proj4 defs cache stays in OPFS — app-global cache, not project data.
- Two tabs on the same folder can race — same pre-existing situation as OPFS;
  out of scope.
- A user can edit/delete files under a live folder project; the restore path's
  "absence = empty, heal derived" tolerance already covers most of this, but
  never assume a write you did is still there — same discipline as OPFS.

**Tests**: root-registry resolution (fake handles); permission-state machine as
a pure function; migration copy round-trip on fake handles. Real
`showDirectoryPicker` needs a manual Chromium run.

---

## Order & effort

1. **Phase 1** (~1 day): fflate dep, `walkProjectFiles`, export/import +
   manifest, importKind + routing, Ribbon entries, tests.
2. **Phase 2a** (~½ day): pluggable root + IDB handle store + `storage` flag +
   reconnect flow.
3. **Phase 2b** (~½–1 day): new-project storage choice, migrations, "open
   folder as project", badges.
