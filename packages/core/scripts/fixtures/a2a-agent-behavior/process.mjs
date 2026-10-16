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
// Same private exact-child TERM/kill pattern as recovery-runtime-fixture, with a
// second finite bound so even an unconfirmed kill cannot hang the proof.
export async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { pid: child?.pid, exited: true, escalated: false }
  child.kill('SIGTERM')
  if (await exited(child, 5000)) return { pid: child.pid, exited: true, escalated: false }
  child.kill('SIGKILL')
  const settled = await exited(child, 5000)
  if (!settled) throw Error('Exact private child exit remains unknown: ' + child.pid)
  return { pid: child.pid, exited: true, escalated: true }
}
export function alive(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
export async function settleExactPid(pid, group = false) {
  if (!pid || !alive(pid, group)) return { pid, group, exited: true, escalated: false }
  process.kill(group ? -pid : pid, 'SIGTERM')
  let deadline = Date.now() + 5000
  while (alive(pid, group) && Date.now() < deadline) await delay(50)
  if (!alive(pid, group)) return { pid, group, exited: true, escalated: false }
  process.kill(group ? -pid : pid, 'SIGKILL')
  deadline = Date.now() + 5000
  while (alive(pid, group) && Date.now() < deadline) await delay(50)
  if (alive(pid, group)) throw Error('Exact private process exit remains unknown: ' + pid)
  return { pid, group, exited: true, escalated: true }
}
