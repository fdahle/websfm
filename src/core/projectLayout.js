// Where each file of a project lives in its folder (docs/project-format.md). One home
// for the paths, so the storage code, the archive and the format migration agree.
//
// From format version 3 the folder's top holds only project.json and folders:
//   data/            the small documents of user data (sensors, GCPs, poses, …)
//   reconstruction/  reconstruction.json and the binary files of its clouds
//   internal/        what WebSfM keeps for itself: last dialog settings, the console
//                    log, run journals, migration copies
// next to the folders that were already there (images/, matches/, depthmaps/, …).
// Before version 3 all of these sat at the top; the migration of version 2 moves the
// JSON documents (core/formatMigrations.js), and the reconstruction's binary files
// are read from either place and moved by the next save (utils/opfs/reconstruction.js).

export const DATA_DIR = 'data'
export const RECONSTRUCTION_DIR = 'reconstruction'
export const INTERNAL_DIR = 'internal'

/** The data/ documents, by their file name. */
export const DATA_DOCUMENTS = [
  'sensors.json',
  'gcps.json',
  'poses.json',
  'scalebars.json',
  'measurements.json',
  'footprints.json',
  'workflows.json',
]

export const RECONSTRUCTION_DOCUMENT = 'reconstruction.json'
export const DIALOGS_PATH = `${INTERNAL_DIR}/dialogs.json`
export const LOG_NAME = 'log.ndjson'
export const LOG_PATH = `${INTERNAL_DIR}/${LOG_NAME}`
export const RUNS_DIR = 'runs' // inside internal/
export const BACKUPS_DIR = 'backups' // inside internal/
export const MIGRATION_STATE = 'format-migration.json' // inside internal/

/** Where version 2 and earlier kept each of the moved documents → where it is now. */
export const MOVED_DOCUMENTS = {
  ...Object.fromEntries(DATA_DOCUMENTS.map((name) => [name, `${DATA_DIR}/${name}`])),
  [RECONSTRUCTION_DOCUMENT]: `${RECONSTRUCTION_DIR}/${RECONSTRUCTION_DOCUMENT}`,
  'dialogs.json': DIALOGS_PATH,
}
