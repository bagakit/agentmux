import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A detached probe owns its process group. Detached Runtime/observer processes
// are additionally identified by this invocation's unique temporary root.
export async function listProbeProcesses(groupId, temporaryRoot) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,stat=,command='], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5_000
  })
  const root = temporaryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ownsPath = new RegExp(`(?:^|[=\\s])${root}(?:/|(?=\\s|$))`)
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    if (!match || match[3].startsWith('Z')) return []
    const pid = Number(match[1])
    return pid !== process.pid && (Number(match[2]) === groupId || ownsPath.test(match[4]))
      ? [pid] : []
  })
}

function signal(pid, name) {
  try { process.kill(pid, name) } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

export async function stopProbeProcesses(groupId, temporaryRoot, graceMs = 1_000) {
  signal(-groupId, 'SIGTERM')
  for (const pid of await listProbeProcesses(groupId, temporaryRoot)) signal(pid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  let remaining = await listProbeProcesses(groupId, temporaryRoot)
  while (remaining.length && Date.now() < deadline) {
    await delay(50)
    remaining = await listProbeProcesses(groupId, temporaryRoot)
  }
  signal(-groupId, 'SIGKILL')
  for (const pid of remaining) signal(pid, 'SIGKILL')
  const killedDeadline = Date.now() + 2_000
  do {
    remaining = await listProbeProcesses(groupId, temporaryRoot)
    if (!remaining.length) return
    await delay(50)
  } while (Date.now() < killedDeadline)
  throw new Error(`Probe cleanup left owned processes: ${remaining.join(', ')}`)
}

// The caller cannot start another probe until this promise has both observed
// exit and reaped owned descendants. An assertion timeout is not an exit receipt.
export async function runProbeProcess(executable, args, {
  temporaryRoot, cwd, env, timeoutMs, onLine = () => {}, graceMs = 1_000
}) {
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'inherit', 'pipe'] })
  let cleanupPromise
  const cleanup = () => cleanupPromise ??= child.pid
    ? stopProbeProcesses(child.pid, temporaryRoot, graceMs)
    : Promise.resolve()
  let timedOut = false
  let interruption = null
  let abortError
  const abort = () => { void cleanup().catch((error) => { abortError = error }) }
  const onInterrupt = (name) => { interruption = name; abort() }
  const onSigint = () => onInterrupt('SIGINT')
  const onSigterm = () => onInterrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
  const lines = createInterface({ input: child.stderr })
  lines.on('line', (line) => {
    onLine(line)
    // The failure report is published before this marker. Teardown starts now,
    // instead of retaining Electron until the full watchdog budget expires.
    if (line.startsWith('file_editing_probe_failed=')) abort()
  })
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
    })
    await cleanup()
    if (abortError) throw abortError
    return { exitCode, timedOut, interruption }
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    try { await cleanup() } finally {
      lines.close()
      child.stderr.destroy()
    }
  }
}
