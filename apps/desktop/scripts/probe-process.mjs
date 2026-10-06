import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'

const execFileAsync = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ownsProbePath = (command, temporaryRoot) => {
  const root = temporaryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return temporaryRoot.length > 0 && new RegExp(`(?:^|[=\\s])${root}(?:/|(?=\\s|$))`).test(command)
}

// A detached probe owns its process group. Detached Runtime/observer processes
// are additionally identified by this invocation's unique temporary root.
export async function listProbeProcesses(groupId, temporaryRoot) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,stat=,command='], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5_000
  })
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!match || match[3].startsWith('Z')) return []
    const pid = Number(match[1])
    return pid !== process.pid && (Number(match[2]) === groupId || ownsProbePath(match[4], temporaryRoot))
      ? [pid] : []
  })
}

// Recheck this invocation's root immediately before signalling a discovered
// PID. A child can become a zombie after the discovery snapshot; its command
// becomes <defunct>, but it no longer needs a signal.
export async function signalOwnedProbeProcess(pid, temporaryRoot, name, groupId) {
  let stdout
  let observationError
  try {
    const observation = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', groupId === undefined ? 'stat=,command=' : 'pgid=,stat=,command='], {
      timeout: 5_000, maxBuffer: 64 * 1024
    })
    stdout = observation.stdout
  } catch (error) {
    if (error.code === 1 && error.stdout?.trim() === '' && error.stderr?.trim() === '') {
      stdout = error.stdout
      observationError = error
    } else throw error
  }
  // Both a successful empty ps observation and its empty nonzero result can
  // race exit. Neither establishes absence without an OS confirmation.
  if (!stdout.trim()) {
    try { process.kill(pid, 0) } catch (observed) {
      if (observed.code === 'ESRCH') return false
      throw observed
    }
    if (observationError) throw observationError
  }
  let identityText = stdout, observedGroupId
  if (groupId !== undefined) {
    const grouped = /^\s*(\d+)\s+([\s\S]*)$/.exec(stdout)
    assert.ok(grouped, 'Private process group could not be observed')
    observedGroupId = Number(grouped[1])
    identityText = grouped[2]
  }
  const state = /^\s*(\S+)/.exec(identityText)?.[1]
  if (state?.startsWith('Z')) return false
  const identity = /^\s*(\S+)\s+(.+)\s*$/.exec(identityText)
  assert.ok(identity && /^[RSDTIUWZ]/.test(identity[1]),
    `Private process state could not be observed (state=${JSON.stringify(state ?? null)}, chars=${stdout.length})`)
  assert.ok(ownsProbePath(identity[2], temporaryRoot) || (groupId !== undefined && observedGroupId === groupId), 'Private process identity changed')
  try { process.kill(pid, name) } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
  return true
}

export async function stopProbeProcesses(groupId, temporaryRoot, graceMs = 1_000) {
  let remaining = await listProbeProcesses(groupId, temporaryRoot)
  if (!remaining.length) return
  // The leader may have already exited while a detached temporary-root observer
  // remains. Signal the observed owners, never an empty or unrelated old group.
  for (const pid of remaining) await signalOwnedProbeProcess(pid, temporaryRoot, 'SIGTERM', groupId)
  const deadline = Date.now() + graceMs
  remaining = await listProbeProcesses(groupId, temporaryRoot)
  while (remaining.length && Date.now() < deadline) {
    await delay(50)
    remaining = await listProbeProcesses(groupId, temporaryRoot)
  }
  if (!remaining.length) return
  for (const pid of remaining) await signalOwnedProbeProcess(pid, temporaryRoot, 'SIGKILL', groupId)
  const killedDeadline = Date.now() + 2_000
  do {
    remaining = await listProbeProcesses(groupId, temporaryRoot)
    if (!remaining.length) return
    await delay(50)
  } while (Date.now() < killedDeadline)
  throw new Error(`Probe cleanup left owned processes: ${remaining.join(', ')}`)
}

// This receipt belongs only to the ChildProcess spawned here. It says nothing
// about independently owned Runtime resources or descendants. A signal is not exit.
export async function runProbeProcess(executable, args, {
  cwd, env, timeoutMs, onLine = () => {}, graceMs = 1_000
}) {
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'inherit', 'pipe'] })
  const outcome = { originalPid: child.pid ?? null, exitCode: null, originalExitCode: null,
    exitSignal: null, exitConfirmed: false, timedOut: false, interruption: null,
    cleanup: 'unknown', signals: [], cleanupErrors: [] }
  return await new Promise((resolve, reject) => {
    let settled = false, stopping = false, primary, timer, hardStop, unknownStop, lines
    const cleanupErrors = []
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(hardStop); clearTimeout(unknownStop)
      process.off('SIGINT', onSigint); process.off('SIGTERM', onSigterm)
      lines?.close()
      if (!outcome.exitConfirmed) {
        // Release only this observer's handles; keep the unconfirmed owner in the receipt.
        child.unref(); child.stderr?.destroy()
      }
      const failures = [...(primary === undefined ? [] : [primary]), ...cleanupErrors]
      if (!outcome.exitConfirmed) failures.push(new Error('The original private child exit is unconfirmed; retain its namespace.'))
      if (failures.length) {
        const failure = new AggregateError(failures, 'Private probe failed; original and cleanup errors are retained.')
        failure.probe = outcome
        reject(failure)
      } else resolve(outcome)
    }
    const signalOriginal = signal => {
      if (settled || outcome.exitConfirmed || child.exitCode !== null || child.signalCode !== null) return
      try { outcome.signals.push({ signal, accepted: child.kill(signal) }) }
      catch (error) {
        cleanupErrors.push(error)
        outcome.cleanupErrors.push({ name: error.name, message: error.message, stack: error.stack, ...(error.code ? { code: error.code } : {}) })
      }
    }
    const stopOriginal = () => {
      if (settled || stopping || outcome.exitConfirmed) return
      stopping = true
      signalOriginal('SIGTERM')
      if (settled) return
      hardStop = setTimeout(() => signalOriginal('SIGKILL'), graceMs)
      unknownStop = setTimeout(finish, graceMs + 2_000)
    }
    const onSigint = () => { outcome.interruption = 'SIGINT'; stopOriginal() }
    const onSigterm = () => { outcome.interruption = 'SIGTERM'; stopOriginal() }
    child.once('error', error => {
      if (settled) return
      primary ??= error
      if (child.pid === undefined) finish()
      else stopOriginal()
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      outcome.exitConfirmed = true
      outcome.originalExitCode = code
      outcome.exitCode = signal ? 1 : code ?? 1
      outcome.exitSignal = signal
      outcome.cleanup = 'original-child-exited'
      finish()
    })
    // The original child observers exist before any cancellation entry point.
    process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm)
    timer = setTimeout(() => { outcome.timedOut = true; stopOriginal() }, timeoutMs)
    lines = createInterface({ input: child.stderr })
    lines.on('line', line => {
      if (settled) return
      try { onLine(line) } catch (error) { primary ??= error; stopOriginal() }
      // Explicit private-fixture notification from this child's own stderr;
      // its human-readable payload neither selects nor authorizes another process.
      if (line.startsWith('file_editing_probe_failed=')) stopOriginal()
    })
  })
}
