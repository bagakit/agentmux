import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)

// Classify `ps -axo pid=,command=` output for one installed AgentMux bundle.
//
// Three install steps ask about that bundle's processes — "is anything still
// running we must not clobber?" (quitInstalledApplication), "did the new
// bundle actually start?" (relaunchInstalledApplication) and "did a process
// from the PREVIOUS install survive?" (the survivor assertion). All three mean
// the same thing by "a process": one that is *serving* the bundle. The main
// process and the renderer/GPU/utility helpers each keep the old code alive
// and MUST count — that is the prior observation protection (an old instance kept
// serving out of the Trash by inode while every disk check passed).
//
// A crash-reporter helper does NOT serve the bundle. When the instance it
// belonged to exits, launchd reparents it (PPID 1) and it lingers, holding no
// user state and flushing nothing; it cannot serve UI. Counting it made a
// stale one block every future install (observed live prior observation, pid 1033).
// External Electron-as-Node clients can share the Main executable. Only a
// bound OS mode observation and a complete ancestry outside the GUI distinguish
// them; Main's own Node workers and unknown future helpers remain protected.

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

function isBundleImage(image, bundle) {
  return typeof image === 'string' && (image === bundle.executable ||
    image.startsWith(bundle.helperRoot) && !image.endsWith('/chrome_crashpad_handler'))
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

function processRows(psStdout, allowEmpty = false) {
  const rows = psStdout.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    assert(match, 'Application process birth observation is unavailable.')
    const uid = Number(match[1]), pid = Number(match[2]), ppid = Number(match[3])
    assert(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(ppid) && ppid >= 0)
    return { uid, pid, ppid, birth: match[4].replace(/\s+/g, ' '), command: match[5] }
  })
  assert(allowEmpty || rows.length > 0, 'The OS process observation is empty.')
  return rows
}

const classifications = new Set(['gui', 'unknown', 'external'])
const identityMatches = (left, right) => !!left && !!right && left.uid === right.uid && left.pid === right.pid && left.birth === right.birth
function assertAdmissions(admissions) {
  for (const admission of admissions) assert(Number.isSafeInteger(admission.uid) && admission.uid >= 0 &&
    Number.isSafeInteger(admission.pid) && admission.pid > 0 && typeof admission.birth === 'string' && admission.birth.length > 0 &&
    classifications.has(admission.classification) && typeof admission.source === 'string' &&
    classifications.has(admission.initial?.classification) && typeof admission.initial?.source === 'string',
  'Application admission identity or provenance is unavailable; its processes are retained.')
}

/** Commands discover candidates; bound OS identities keep them observable across title changes. */
export function snapshotApplicationProcesses(psStdout, bundle, { nodeModes = [], previousOwners = [], independentOwners = [], unconfirmedAncestors = new Set() } = {}) {
  assertAdmissions(previousOwners)
  const rows = processRows(psStdout), byPid = new Map(rows.map(row => [row.pid, row]))
  const classified = classifyApplicationProcesses(rows.map(row => `${row.pid} ${row.command}`).join('\n'), bundle)
  const modes = new Map(nodeModes.map(row => [row.pid, row]))
  const selected = new Set(classified.serving)
  const boundModes = new Map(rows.flatMap(row => {
    const mode = modes.get(row.pid)
    return ['node', 'gui'].includes(mode?.mode) && isBundleImage(mode.executable, bundle) && mode.uid === process.getuid() && mode.uid === row.uid &&
      mode.birth === row.birth && mode.ppid === row.ppid ? [[row.pid, mode.mode]] : []
  }))
  const previous = new Map(previousOwners.filter(admission => identityMatches(admission, byPid.get(admission.pid))).map(admission => [admission.pid, admission]))
  const independent = new Set(independentOwners.filter(owner => {
    const current = byPid.get(owner.pid)
    return identityMatches(owner, current) && boundModes.get(owner.pid) === 'node' &&
      typeof owner.command === 'string' && owner.command === current.command
  }).map(owner => owner.pid))
  const candidates = [...new Set([...classified.serving, ...previous.keys()])]
  const gui = new Map(candidates.flatMap(pid => {
    const row = byPid.get(pid), admission = previous.get(pid)
    if (admission?.confirmedGui || admission?.classification === 'gui') return [[pid, {
      source: 'retained-gui', confirmedGui: admission.confirmedGui ?? { source: admission.source, ppid: admission.ppid }
    }]]
    if (row.uid !== process.getuid()) return []
    return boundModes.get(pid) === 'gui' ? [[pid, { source: modes.get(pid).executable === bundle.executable ? 'bound-gui' : 'bundle-helper' }]] : []
  }))
  const ancestry = row => {
    let parent = row, uncertain = false, missingPid = row.pid, termination = 'missing-process', classification = 'unknown'
    const visited = new Set(), path = []
    while (parent) {
      if (visited.has(parent.pid)) { termination = 'cyclic'; missingPid = null; break }
      const { uid, pid, ppid, birth } = parent
      path.push({ uid, pid, ppid, birth })
      visited.add(parent.pid)
      if (unconfirmedAncestors.has(parent.pid)) uncertain = true
      if (independent.has(parent.pid)) { termination = 'independent-owner'; missingPid = null; if (!uncertain) classification = 'external'; break }
      if (gui.has(parent.pid)) { termination = 'gui-owner'; missingPid = null; if (!uncertain) classification = 'gui'; break }
      if (parent.pid === 1) { termination = 'system-root'; missingPid = null; if (!uncertain) classification = 'external'; break }
      if (parent.uid !== row.uid || selected.has(parent.pid) && boundModes.get(parent.pid) !== 'node') uncertain = true
      missingPid = parent.ppid; parent = byPid.get(parent.ppid); termination = 'missing-parent'
    }
    return { classification, path, termination, missingPid }
  }
  const modeEvidence = row => {
    const mode = modes.get(row.pid), mismatch = [], unknown = []
    if (mode) for (const key of ['uid', 'pid', 'ppid', 'birth', 'executable']) {
      if (mode[key] == null) unknown.push(key)
      else if (key === 'executable' ? !isBundleImage(mode[key], bundle) : mode[key] !== row[key]) mismatch.push(key)
    }
    if (mode?.uid != null && mode.uid !== process.getuid() && !mismatch.includes('uid')) mismatch.push('uid')
    return { status: !mode ? 'not-observed' : mismatch.length ? 'binding-mismatch'
      : unknown.length || !['node', 'gui'].includes(mode.mode) ? 'unknown' : 'bound',
    observation: mode ? { uid: mode.uid ?? null, pid: mode.pid, ppid: mode.ppid ?? null, birth: mode.birth ?? null,
      mode: ['node', 'gui'].includes(mode.mode) ? mode.mode : 'unknown', executableMatches: mode.executable == null ? null : isBundleImage(mode.executable, bundle) } : null,
    mismatch, unknown }
  }
  const classify = (row, path) => {
    if (gui.has(row.pid)) return { classification: 'gui', ...gui.get(row.pid) }
    if (boundModes.get(row.pid) !== 'node') return { classification: 'unknown', source: 'mode-unconfirmed' }
    return { classification: path.classification, source: path.classification === 'gui' ? 'gui-ancestry'
      : path.classification === 'external' ? path.termination : 'ancestry-unconfirmed' }
  }
  const currentAdmissions = candidates.map(pid => {
    const row = byPid.get(pid), { uid, ppid, birth } = row, prior = previous.get(pid), path = ancestry(row), current = classify(row, path)
    const { classification: _classification, ...originalAncestry } = path
    return { uid, pid, ppid, birth, classification: current.classification, source: current.source,
      initial: prior?.initial ?? { classification: current.classification, source: current.source, ppid, mode: modeEvidence(row), ancestry: originalAncestry },
      ...(current.classification === 'gui' ? { confirmedGui: current.confirmedGui ?? { source: current.source, ppid } } : {}) }
  })
  // Admission history is scoped to this installer operation, not process life.
  // Absence is an OS observation; it does not erase a prior GUI confirmation.
  const admissions = [...previousOwners.filter(prior => !identityMatches(prior, byPid.get(prior.pid))), ...currentAdmissions]
  return { serving: currentAdmissions.filter(row => row.classification !== 'external').map(row => row.pid),
    crashReporter: classified.crashReporter, externalNode: currentAdmissions.filter(row => row.classification === 'external').map(row => row.pid), admissions,
    processes: rows.map(({ pid, ppid, birth }) => ({ pid, ppid, birth })) }
}


async function electronNodeModes(pids) {
  if (!pids.length) return []
  try {
    // A slow OS observation is not an unknown owner; wait for its fenced result.
    const result = await exec(process.execPath,
      [fileURLToPath(new URL('./package-native-observation.mjs', import.meta.url)), '--node-modes', ...pids.map(String)],
      { maxBuffer: 256 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    return JSON.parse(result.stdout)
  } catch { return [] } // Unknown stays protected. It is not proof of process exit.
}

async function osProcessSnapshot(pids) {
  const args = pids ? ['-p', pids.join(','), '-o', 'uid=,pid=,ppid=,lstart=,command=']
    : ['-axo', 'uid=,pid=,ppid=,lstart=,command=']
  try {
    return (await exec('/bin/ps', args,
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout
  } catch (error) {
    // ps exits 1 when no selected PID exists. An OS read error is not absence.
    if (pids && error.code === 1 && typeof error.stdout === 'string' && !error.stderr?.trim()) return error.stdout
    throw error
  }
}

/** A global discovery cut followed by a finite identity/ancestry fence, never a quiescence loop. */
export async function observeApplicationProcesses(bundle, previousOwners = [],
  { processSnapshot = osProcessSnapshot, modes = electronNodeModes, independentOwners = [] } = {}) {
  const candidates = (rows, owners) => {
    const prior = new Map(owners.map(owner => [owner.pid, owner]))
    return rows.filter(row => row.command === bundle.executable || row.command.startsWith(`${bundle.executable} `) ||
      row.command.startsWith(bundle.helperRoot) && !isCrashReporter(row.command) || identityMatches(prior.get(row.pid), row))
  }
  const snapshot = (text, nodeModes, owners, unconfirmedAncestors) => snapshotApplicationProcesses(text, bundle,
    { nodeModes, previousOwners: owners, independentOwners, unconfirmedAncestors })
  const first = await processSnapshot(), initial = candidates(processRows(first), previousOwners)
  const requested = new Set(initial.map(row => row.pid))
  const original = snapshot(first, await modes(initial.map(row => row.pid)), previousOwners)
  // This second global census is the discovery cut. Its late GUI/unknown births
  // are included; births after this cut are not claimed to have been observed.
  const cut = await processSnapshot(), rows = processRows(cut), selected = candidates(rows, original.admissions)
  for (const row of selected) requested.add(row.pid)
  const nodeModes = await modes(selected.map(row => row.pid))
  const admitted = snapshot(cut, nodeModes, original.admissions)
  const byPid = new Map(rows.map(row => [row.pid, row])), fence = new Set()
  for (const candidate of selected) {
    let row = candidate
    const visited = new Set()
    while (row && !visited.has(row.pid)) {
      fence.add(row.pid); visited.add(row.pid)
      if (row.ppid > 0) fence.add(row.ppid)
      row = byPid.get(row.ppid)
    }
  }
  // Keep the final OS read, but ask only about these finite identities and
  // ancestors. A new global census here would introduce an unqueried CLI tail.
  const observed = fence.size ? processRows(await processSnapshot([...fence]), true).filter(row => fence.has(row.pid)) : []
  const current = new Map(observed.map(row => [row.pid, row]))
  const merged = rows.flatMap(row => fence.has(row.pid) ? current.has(row.pid) ? [current.get(row.pid)] : [] : [row])
  for (const row of observed) if (!byPid.has(row.pid)) merged.push(row)
  // Preserve every unselected cut row for launch-baseline birth checks. Only
  // exact queried objects are updated/removed by the successful targeted ps.
  const text = merged.map(row => `${row.uid} ${row.pid} ${row.ppid} ${row.birth} ${row.command}`).join('\n')
  const unconfirmedAncestors = new Set(observed.filter(row => {
    const original = byPid.get(row.pid)
    return !identityMatches(original, row) || original.ppid !== row.ppid
  }).map(row => row.pid))
  const scope = snapshot(text, nodeModes, admitted.admissions, unconfirmedAncestors)
  const identities = new Map(merged.map(({ uid, pid, ppid, birth }) => [pid, { uid, pid, ppid, birth }]))
  return { ...scope, nodeModes: nodeModes.filter(mode =>
    identityMatches(mode, identities.get(mode.pid)) && mode.ppid === identities.get(mode.pid).ppid),
    // Internal point-time facts. The failure receipt selects only its affected
    // identity and ancestry; commands, argv and environment never enter it.
    ownershipObservation: { executable: bundle.executable, helperRoot: bundle.helperRoot, requested, admissions: new Map(scope.admissions.filter(admission =>
      identityMatches(admission, identities.get(admission.pid))).map(row => [row.pid, row])), identities,
      modes: new Map(nodeModes.map(({ pid, ppid, birth, uid, mode, executable }) =>
        [pid, { pid, ppid: ppid ?? null, birth: birth ?? null, uid: uid ?? null,
          mode: mode ?? null, executable: executable ?? null }])) } }
}

function ownershipDiagnostic({ stage, pid, mainPid, before, after, previous, observation }) {
  const identity = id => {
    const row = observation?.identities.get(id) ?? after.get(id)
    return row ? { uid: row.uid ?? null, pid: row.pid, ppid: row.ppid, birth: row.birth ?? null } : null
  }
  const current = identity(pid), mode = observation?.modes.get(pid)
  const unknown = mode ? ['uid', 'birth', 'ppid', 'executable'].filter(key => mode[key] == null) : []
  const mismatch = mode && current ? ['uid', 'birth', 'ppid'].filter(key => mode[key] != null && mode[key] !== current[key]) : []
  if (mode) {
    if (mode.uid != null && mode.uid !== process.getuid() && !mismatch.includes('uid')) mismatch.push('uid')
    if (mode.executable != null && !isBundleImage(mode.executable, observation)) mismatch.push('executable')
  }
  const path = [], visited = new Set()
  let parent = current, termination = 'missing-process', missingPid = pid
  while (parent) {
    if (visited.has(parent.pid)) { termination = 'cyclic'; missingPid = null; break }
    path.push(parent); visited.add(parent.pid)
    if (parent.pid === mainPid || parent.pid === 1) {
      termination = parent.pid === mainPid ? 'loaded-main' : 'system-root'; missingPid = null; break
    }
    missingPid = parent.ppid; parent = identity(parent.ppid); termination = 'missing-parent'
  }
  return { schema: 'agentmux.application-ownership-diagnostic.v1', stage, mainPid,
    loadedMain: identity(mainPid), affected: { identity: current,
      mode: { status: !observation ? 'unavailable' : !mode ? observation.requested.has(pid) ? 'not-returned' : 'not-requested'
        : mismatch.length ? 'binding-mismatch' : unknown.length || !['node', 'gui'].includes(mode.mode) ? 'unknown' : 'bound',
      observation: mode ?? null, mismatch, unknown },
      admission: observation?.admissions?.get(pid) ?? null,
      previousAdmission: previous.find(row => identityMatches(row, current)) ?? null,
      previousSameBirth: !!current && previous.some(row => row.pid === pid && row.birth === current.birth),
      beforeLaunchSameBirth: !!current && before.get(pid)?.birth === current.birth },
    ancestry: { path, termination, missingPid } }
}

/** Explain only the original normal-quit survivor; this never authorizes an effect. */
export function applicationQuitOwnershipDiagnostic(scope, previous) {
  if (!scope.serving.length) return null
  return { ...ownershipDiagnostic({ stage: 'graceful-quit', pid: scope.serving[0], mainPid: null,
    before: new Map(), after: new Map(scope.processes.map(row => [row.pid, row])), previous,
    observation: scope.ownershipObservation }), remainingCount: scope.serving.length }
}

/** Late helpers belong to the observed new Main; a launch-time PID list is not an owner. */
export function assertApplicationActivationOwnership({ previous, beforeLaunch, current, serving, mainPid, observation }) {
  const before = new Map(beforeLaunch.map(row => [row.pid, row]))
  const after = new Map(current.map(row => [row.pid, row]))
  let stage = 'previous-owner', pid = mainPid
  try {
    assertAdmissions(previous)
    for (const row of previous) {
      pid = row.pid
      const identity = observation?.identities.get(row.pid), admission = observation?.admissions?.get(row.pid)
      const released = row.classification !== 'gui' && !row.confirmedGui && identityMatches(row, identity) &&
        identityMatches(row, admission) && admission.classification === 'external' && !admission.confirmedGui
      assert(after.get(row.pid)?.birth !== row.birth || released,
        `A previous application owner is still running (pid ${row.pid}). Its old image cannot be declared replaced.`)
    }
    stage = 'loaded-main'; pid = mainPid
    const main = after.get(mainPid)
    assert(main && main.birth && serving.includes(mainPid), 'The loaded Main has no current application process observation.')
    stage = 'main-birth'
    assert(before.get(mainPid)?.birth !== main.birth, 'The loaded Main existed before candidate launch; new activation is unconfirmed.')
    return serving.map(ownerPid => {
      pid = ownerPid; stage = 'owner-birth'
      const owner = after.get(pid)
      assert(owner?.birth, `Application process birth is unavailable (pid ${pid}).`)
      stage = 'owner-launch'
      assert(before.get(pid)?.birth !== owner.birth, `Application process ${pid} existed before candidate launch; its new ownership is unconfirmed.`)
      const visited = new Set()
      let parent = owner
      stage = 'owner-ancestry'
      while (parent.pid !== mainPid) {
        assert(!visited.has(parent.pid), `Application process ancestry is cyclic (pid ${pid}).`)
        visited.add(parent.pid)
        parent = after.get(parent.ppid)
        assert(parent, `Application process ${pid} is not a confirmed descendant of the loaded Main.`)
      }
      return owner
    })
  } catch (error) {
    error.ownershipDiagnostic = ownershipDiagnostic({ stage, pid, mainPid, before, after, previous, observation })
    throw error
  }
}
