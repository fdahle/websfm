// The English catalogue, one file per area; a key is `<area>.<path>`. English is the
// reference: every other language has a subset of these keys with the same arguments.
import autoMask from './autoMask.js'
import common from './common.js'
import dialog from './dialog.js'
import filterCloud from './filterCloud.js'
import readText from './readText.js'
import ribbon from './ribbon.js'

export default { autoMask, common, dialog, filterCloud, readText, ribbon }
