// Classify `ps -axo pid=,command=` output for one installed AgentMux bundle.
//
// Three install steps ask about that bundle's processes — "is anything still
// running we must not clobber?" (quitInstalledApplication), "did the new
// bundle actually start?" (relaunchInstalledApplication) and "did a process
// from the PREVIOUS install survive?" (the survivor assertion). All three mean
// the same thing by "a process": one that is *serving* the bundle. The main
// process and the renderer/GPU/utility helpers each keep the old code alive
// and MUST count — that is the 2026-09-01 protection (an old instance kept
// serving out of the Trash by inode while every disk check passed).
//
// A crash-reporter helper does NOT serve the bundle. When the instance it
// belonged to exits, launchd reparents it (PPID 1) and it lingers, holding no
// user state and flushing nothing; it cannot serve UI. Counting it made a
// stale one block every future install (observed live 2026-09-13, pid 1033).
// So it is classified apart — but ONLY it: anything else under the bundle
// stays "serving", so an unknown future helper fails safe by blocking rather
// than being silently ignored.

// The crash-reporter executable's basename is stable across Electron versions.
// Match it in the *executable* position only: strip arguments first (they all
// begin with " -", and no bundle path segment — "AgentMux", "Electron
// Framework.framework", "AgentMux Helper (Renderer)" — contains " -", so the
// cut isolates the executable even though it contains spaces). A renderer/GPU/
// utility helper whose *arguments* mention the crash handler therefore stays
// classified as serving.
function executableOf(command) {
  const argStart = command.indexOf(' -')
  return argStart === -1 ? command : command.slice(0, argStart)
}

function isCrashReporter(command) {
  return executableOf(command).endsWith('/chrome_crashpad_handler')
}

/**
 * @param {string} psStdout  raw stdout of `ps -axo pid=,command=`
 * @param {{ executable: string, helperRoot: string }} bundle
 *   `executable` = <app>/Contents/MacOS/<PRODUCT_NAME>;
 *   `helperRoot` = <app>/Contents/Frameworks/ (trailing separator included)
 * @returns {{ serving: number[], crashReporter: number[] }}
 */
export function classifyApplicationProcesses(psStdout, { executable, helperRoot }) {
  const serving = []
  const crashReporter = []
  for (const line of psStdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const command = match[2]
    const underBundle =
      command === executable ||
      command.startsWith(`${executable} `) ||
      command.startsWith(helperRoot)
    if (!underBundle) continue
    if (command.startsWith(helperRoot) && isCrashReporter(command)) {
      crashReporter.push(Number(match[1]))
    } else {
      serving.push(Number(match[1]))
    }
  }
  return { serving, crashReporter }
}
