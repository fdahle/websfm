// Binds the pure command registry (core/help/commands.js) to real actions: reads
// current guard state, dispatches to App.vue's handleCommand(), and echoes
// everything to the shared log. This is the impure half — the DevConsole prompt
// calls runLine(); the pure parsing/validation stays testable in core.
import {
  resolveCommand,
  guardReason,
  helpLines,
  helpFor,
} from '../core/help/commands.js'
import { useLog } from './useLog.js'

const SOURCE = 'Console'

/**
 * @param {(id:string)=>void} dispatch  App.vue's handleCommand
 * @param {()=>object} getState  returns the current guard state (counts/flags)
 */
export function useCommands(dispatch, getState) {
  const { log, clear } = useLog()

  // Run one raw input line. Echoes the prompt, then resolves + guards + acts.
  // Built-ins (help, clear) are handled here since they need the log/registry;
  // everything else is a thin dispatch to the ribbon command of the same name.
  function runLine(raw) {
    const line = String(raw ?? '').trim()
    if (!line) return
    log(`› ${line}`, 'info', SOURCE)

    const first = line.split(/\s+/)[0].toLowerCase()
    if (first === 'help' || first === '?') { showHelp(line.split(/\s+/)[1]); return }
    if (first === 'clear' || first === 'cls') { clear(); return }

    const res = resolveCommand(line)
    if (res.error === 'unknown') {
      const hint = res.suggestions?.length ? ` Did you mean: ${res.suggestions.join(', ')}?` : ''
      log(`Unknown command: ${res.name}.${hint} Type "help".`, 'error', SOURCE)
      return
    }
    if (res.error) return // empty — already guarded above

    const reason = guardReason(res.cmd.needs, getState?.() ?? {})
    if (reason) { log(reason, 'warn', SOURCE); return }

    if (res.args.length) {
      log(`Ignoring extra arguments: ${res.args.join(' ')}`, 'debug', SOURCE)
    }
    dispatch(res.cmd.dispatch)
  }

  function showHelp(name) {
    if (name) {
      const lines = helpFor(name)
      if (!lines) { log(`No such command: ${name}`, 'error', SOURCE); return }
      for (const l of lines) log(l, 'info', SOURCE)
      return
    }
    log('Available commands (type "help <name>" for detail):', 'info', SOURCE)
    for (const l of helpLines()) log(l, 'info', SOURCE)
    log('  help / clear — this list / clear the console', 'info', SOURCE)
  }

  return { runLine }
}
