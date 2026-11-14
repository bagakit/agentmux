import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

/** OS advisory lock, held by a child whose stdin is this owner's lifetime.
 * The guard inode is stable: no participant ever renames or unlinks it.
 */
export async function acquireMeshStateGuard(directory: string, operationId: string) {
  const path = join(directory, 'owner.guard')
  const file = await open(path, 'a', 0o600)
  await file.close()
  const original = await lstat(path)
  const unavailable = () => Object.assign(new Error('The original Mesh advisory owner is unavailable or already held. No incumbent was replaced.'), { code: 'MESH_STATE_IN_USE_OR_UNCONFIRMED', operationId })
  if (!original.isFile() || original.isSymbolicLink()) throw unavailable()
  const hold = "process.stdout.write('agentmux-mesh-guard-ready\\n');process.stdin.resume();process.stdin.once('end',()=>process.exit(0))"
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : process.platform === 'linux' ? 'flock' : undefined
  if (!command) throw unavailable()
  const args = process.platform === 'darwin' ? ['-k', '-t', '0', path, process.execPath, '-e', hold] : ['--exclusive', '--nonblock', path, process.execPath, '-e', hold]
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stderr.resume()
  let held = false, releasing = false, ended = false
  const lostError = () => Object.assign(new Error('The original Mesh advisory owner ended. Related network activity must stop; identity and operations remain retained.'), { code: 'MESH_STATE_OWNER_LOST', operationId })
  let notifyLoss!: (error: Error) => void
  const lost = new Promise<Error>(resolve => { notifyLoss = resolve })
  child.once('exit', () => { ended = true; held = false; if (!releasing) notifyLoss(lostError()) })
  child.once('error', () => { ended = true; held = false; if (!releasing) notifyLoss(lostError()) })
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(unavailable()), 5000).unref()
      child.stdout.on('data', bytes => {
        output += String(bytes)
        if (output === 'agentmux-mesh-guard-ready\n') { clearTimeout(timer); held = true; resolve() }
        else if (output.includes('\n')) { clearTimeout(timer); reject(unavailable()) }
      })
      child.once('error', () => { clearTimeout(timer); reject(unavailable()) })
      child.once('exit', () => { clearTimeout(timer); reject(unavailable()) })
    })
    const current = await lstat(path)
    if (!held || current.dev !== original.dev || current.ino !== original.ino) throw unavailable()
  } catch (error) {
    releasing = true; child.stdin.end()
    if (!ended) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit }
    throw error
  }
  return { pid: child.pid!, lost,
    current() { if (!held || ended || child.exitCode !== null || child.signalCode !== null) throw lostError() },
    async release() {
      releasing = true
      child.stdin.end()
      if (!ended) await once(child, 'exit')
      held = false
    },
  }
}
