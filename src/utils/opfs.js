// Project storage: the Origin Private File System, or a folder the user picked
// (setProjectRoot). One module per kind of data under ./opfs/; this file is the
// public surface, so callers keep `import * as opfs from '…/utils/opfs.js'`.
export { clearProjectRoot, isStorageFull, setProjectRoot } from './opfs/base.js'
export { binaryDocumentLockKey, binaryDocumentOf, copyTree, deleteOpfsProjectTree, deleteProject, deleteProjectDerived, dirIsEmpty, ensureDurableStorage, getOpfsProjectDir, getProjectFile, getQuota, isAvailable, measureTree, readAppJson, readIndex, readJsonAt, readProject, requestDurable, updateProject, walkProjectFiles, withBinaryDocumentLock, writeAppJson, writeFileAt, writeIndex, writeProject, writeProjectFile } from './opfs/projects.js'
export { deleteDepth, deleteImage, deleteImageDerived, deleteMask, loadDepthFile, loadImageBlob, loadImageDerivedBlob, loadMaskFile, projectSubDirs, saveDepth, saveImage, saveImageDerived, saveMask } from './opfs/images.js'
export { clearAllMatches, deleteDescriptors, deleteKeypoints, listKeypointFiles, loadColors, loadDescriptors, loadKeypoints, loadMatchIndex, loadMatchesFile, saveColors, saveDescriptors, saveKeypoints, saveMatchDocument } from './opfs/features.js'
export { beginDepthPlanes, commitDepthIndex, deleteDepthPlanes, loadDepthFiles, loadDepthIndex, saveDepthPlane, saveDepthPlanes } from './opfs/depth.js'
export { deleteExternalAll, deleteExternalPlane, hasExternalPlane, loadExternalCog, loadExternalIndex, loadExternalPlane, loadExternalSource, pruneExternalPlanes, saveExternalCog, saveExternalIndex, saveExternalPlane, saveExternalSource } from './opfs/external.js'
export { deleteFootprints, deleteGcps, deleteMeasurements, deletePoses, deleteScaleBars, deleteSensors, deleteWorkflows, loadFootprints, loadGcps, loadMeasurements, loadPoses, loadScaleBars, loadSensors, loadWorkflows, saveFootprints, saveGcps, saveMeasurements, savePoses, saveScaleBars, saveSensors, saveWorkflows } from './opfs/documents.js'
export { appendLog, deleteLog, readLog, readLogTail, truncateLog } from './opfs/log.js'
export { deleteReconstruction, loadLodFile, loadReconstruction, lodDir, pruneLodFiles, saveReconstruction } from './opfs/reconstruction.js'
export { deleteProduct, deleteProducts, loadProduct, saveProduct } from './opfs/products.js'
