// Binds the console executor (core/help/console.js) to the app: the DevConsole prompt
// calls runLine(); the environment it acts through (dispatch, guard state, the workflow
// runner, the stores the verbs use) comes from useConsoleEnv in App.vue. Parsing,
// guards and the verbs stay pure and tested in core.
import { runConsoleLine, argCompletionsFor } from '../core/help/console.js'
import { completions } from '../core/help/commands.js'

/** @param {() => object} getEnv  the console environment (useConsoleEnv) */
export function useCommands(getEnv) {
  function runLine(raw) {
    const env = getEnv()
    if (env) runConsoleLine(raw, env)
  }
  // Tab completion: command names, then a verb's arguments (tuning keys, run stages,
  // workflow and image names).
  function complete(prefix) {
    return completions(prefix, argCompletionsFor(getEnv()))
  }
  return { runLine, complete }
}
