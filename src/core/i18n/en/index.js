// The English catalogue, one file per area; a key is `<area>.<path>`. English is the
// reference: every other language has a subset of these keys with the same arguments.
import about from './about.js'
import accuracy from './accuracy.js'
import autoMask from './autoMask.js'
import common from './common.js'
import consolePanel from './console.js'
import dialog from './dialog.js'
import exportDialog from './export.js'
import filterCloud from './filterCloud.js'
import flags from './flags.js'
import gcps from './gcps.js'
import importSfm from './importSfm.js'
import mapLayers from './mapLayers.js'
import matchList from './matchList.js'
import optimizeCameras from './optimizeCameras.js'
import projectSettings from './projectSettings.js'
import quality from './quality.js'
import readText from './readText.js'
import rebuild from './rebuild.js'
import ribbon from './ribbon.js'
import settings from './settings.js'
import sidebar from './sidebar.js'
import view3d from './view3d.js'
import sparse from './sparse.js'

export default {
  about,
  accuracy,
  autoMask,
  common,
  console: consolePanel,
  dialog,
  export: exportDialog,
  filterCloud,
  flags,
  gcps,
  importSfm,
  mapLayers,
  matchList,
  optimizeCameras,
  projectSettings,
  quality,
  readText,
  rebuild,
  ribbon,
  settings,
  sidebar,
  sparse,
  view3d,
}
