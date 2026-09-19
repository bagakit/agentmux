import assert from 'node:assert/strict'

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

/** One OS observation; process commands are used for scope, not retained as output. */
export function snapshotApplicationProcesses(psStdout, bundle) {
  const rows = psStdout.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    assert(match, 'Application process birth observation is unavailable.')
    const pid = Number(match[1]), ppid = Number(match[2])
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0)
    return { pid, ppid, birth: match[3].replace(/\s+/g, ' '), command: match[4] }
  })
  assert(rows.length > 0, 'The OS process observation is empty.')
  return { ...classifyApplicationProcesses(rows.map(row => `${row.pid} ${row.command}`).join('\n'), bundle),
    processes: rows.map(({ pid, ppid, birth }) => ({ pid, ppid, birth })) }
}

/** Late helpers belong to the observed new Main; a launch-time PID list is not an owner. */
export function assertApplicationActivationOwnership({ previous, beforeLaunch, current, serving, mainPid }) {
  const before = new Map(beforeLaunch.map(row => [row.pid, row]))
  const after = new Map(current.map(row => [row.pid, row]))
  for (const row of previous) {
    assert(after.get(row.pid)?.birth !== row.birth,
      `A previous application owner is still running (pid ${row.pid}). Its old image cannot be declared replaced.`)
  }
  const main = after.get(mainPid)
  assert(main && main.birth && serving.includes(mainPid), 'The loaded Main has no current application process observation.')
  assert(before.get(mainPid)?.birth !== main.birth, 'The loaded Main existed before candidate launch; new activation is unconfirmed.')
  return serving.map(pid => {
    const owner = after.get(pid)
    assert(owner?.birth, `Application process birth is unavailable (pid ${pid}).`)
    assert(before.get(pid)?.birth !== owner.birth, `Application process ${pid} existed before candidate launch; its new ownership is unconfirmed.`)
    const visited = new Set()
    let parent = owner
    while (parent.pid !== mainPid) {
      assert(!visited.has(parent.pid), `Application process ancestry is cyclic (pid ${pid}).`)
      visited.add(parent.pid)
      parent = after.get(parent.ppid)
      assert(parent, `Application process ${pid} is not a confirmed descendant of the loaded Main.`)
    }
    return owner
  })
}
