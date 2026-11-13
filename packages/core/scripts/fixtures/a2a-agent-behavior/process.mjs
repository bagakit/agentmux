import { setTimeout as delay } from 'node:timers/promises'

export async function bounded(operation, milliseconds, label) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
export async function exited(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  let listener, timer
  try { return await Promise.race([new Promise(done => { listener = () => done(true); child.once('exit', listener) }),
    new Promise(done => { timer = setTimeout(() => done(false), milliseconds) })]) }
  finally { clearTimeout(timer); if (listener) child.removeListener('exit', listener) }
}
const children = new WeakMap()
const childExited = child => child.exitCode !== null || child.signalCode !== null
const identityError = (message, cause) => Object.assign(new Error(message, { cause }), { code: 'PRIVATE_PROCESS_IDENTITY_UNCONFIRMED' })

// The caller supplies the selected Core's nativeProcessBirth. A frozen harness
// must not silently observe processes through another source tree's dist.
async function processIdentity(pid, nativeProcessBirth) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof nativeProcessBirth !== 'function') throw identityError('Original private process identity is unavailable')
  const birth = await nativeProcessBirth(pid, AbortSignal.timeout(4000))
  if (typeof birth !== 'string' || !birth) throw identityError('Original private process birth is unavailable')
  return { pid, birth }
}

export const selfProcessIdentity = nativeProcessBirth => processIdentity(process.pid, nativeProcessBirth)

export function registerChild(child, nativeProcessBirth) {
  if (children.has(child)) throw identityError('Private child was already registered')
  const identity = (async () => {
    if (childExited(child)) return { pid: child.pid, exited: true }
    try {
      const original = await processIdentity(child.pid, nativeProcessBirth)
      return childExited(child) ? { ...original, exited: true } : original
    } catch (error) {
      if (childExited(child)) return { pid: child.pid, exited: true }
      throw identityError('Original private child birth remains unknown: ' + child.pid, error)
    }
  })()
  children.set(child, { identity, nativeProcessBirth })
  // Retain the original handle even if writing its receipt fails before await.
  void identity.catch(() => {})
  return identity
}

async function confirmIdentity(original, nativeProcessBirth) {
  if (!original || !Number.isSafeInteger(original.pid) || original.pid <= 0 || typeof original.birth !== 'string' || !original.birth) throw identityError('Saved private process identity is incomplete')
  if (!alive(original.pid)) return false
  let current
  try { current = await processIdentity(original.pid, nativeProcessBirth) }
  catch (error) {
    if (!alive(original.pid)) return false
    throw identityError('Private process birth cannot be rechecked: ' + original.pid, error)
  }
  if (current.birth !== original.birth) throw identityError('Private process birth changed; no signal sent: ' + original.pid)
  return true
}

export async function signalChild(child, signal) {
  if (childExited(child)) return false
  const owner = children.get(child)
  if (!owner) throw identityError('Private child has no original birth registration: ' + child.pid)
  const original = await owner.identity
  if (childExited(child) || !await confirmIdentity(original, owner.nativeProcessBirth)) return false
  return child.kill(signal)
}

// A ChildProcess exit is authoritative for that original child. Otherwise every
// signal rechecks its registered kernel identity, including KILL escalation.
export async function terminate(child) {
  if (!child || childExited(child)) return { pid: child?.pid, exited: true, escalated: false }
  await signalChild(child, 'SIGTERM')
  if (await exited(child, 5000)) return { pid: child.pid, exited: true, escalated: false }
  await signalChild(child, 'SIGKILL')
  const settled = await exited(child, 5000)
  if (!settled) throw Error('Exact private child exit remains unknown: ' + child.pid)
  return { pid: child.pid, exited: true, escalated: true }
}
export function alive(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
export async function settleExactProcess(original, nativeProcessBirth, group = false) {
  const pid = original?.pid
  if (!Number.isSafeInteger(pid) || pid <= 0) throw identityError('Saved private process PID is incomplete')
  const confirm = async () => {
    if (original.exited === true) {
      if (group && alive(pid, true)) throw identityError('Original private group outlived its confirmed leader: ' + pid)
      return false
    }
    const current = await confirmIdentity(original, nativeProcessBirth)
    if (!current && group && alive(pid, true)) throw identityError('Private group identity remains unknown after leader exit: ' + pid)
    return current
  }
  if (!await confirm()) return { pid, group, exited: true, escalated: false }
  process.kill(group ? -pid : pid, 'SIGTERM')
  let deadline = Date.now() + 5000
  while (alive(pid, group) && Date.now() < deadline) await delay(50)
  if (!alive(pid, group)) return { pid, group, exited: true, escalated: false }
  if (!await confirm()) return { pid, group, exited: true, escalated: false }
  process.kill(group ? -pid : pid, 'SIGKILL')
  deadline = Date.now() + 5000
  while (alive(pid, group) && Date.now() < deadline) await delay(50)
  if (alive(pid, group)) throw Error('Exact private process exit remains unknown: ' + pid)
  return { pid, group, exited: true, escalated: true }
}
