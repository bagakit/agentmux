import { createServer } from 'node:net'
import { chmod, lstat } from 'node:fs/promises'

// Own only listener admission. Core receives each Socket and owns all RPC semantics.
// Exit closes the named handle through the kernel without libuv's pathname unlink;
// Core separately removes only its verified inode. Never transfer a Unix Server:
// Node's receive path wraps its FD twice and leaves a stale Pipe owner on shutdown.
const path = process.argv[2]
if (!path || !process.send) process.exit(1)
process.once('disconnect', () => process.exit(1))
const pending = new Map<number, { socket: import('node:net').Socket; sent: boolean }>()
let nextId = 0, sending = false, capacityBlocked = false
function flush(): void {
  if (sending) return
  const entry = [...pending].find(([, value]) => !value.sent)
  if (!entry) return
  const [connection, value] = entry
  value.sent = true; sending = true
  // Wait even when send returns true; false also resumes only after its callback.
  process.send!({ connection }, value.socket, { keepOpen: false }, error => {
    sending = false
    if (error) { value.socket.destroy(); process.exit(1) }
    flush()
  })
}
process.on('message', message => {
  if (!message || typeof message !== 'object' || !('admitted' in message)) return
  if (!pending.delete((message as { admitted: number }).admitted)) return
  if (capacityBlocked) { capacityBlocked = false; process.send!({ pending: pending.size }) }
})
const server = createServer({ pauseOnConnect: true }, socket => {
  // These are real pending descriptors, not Sessions or already transferred RPCs.
  if (pending.size === 64) {
    socket.destroy()
    if (!capacityBlocked) { capacityBlocked = true; process.send!({ pending: pending.size }) }
    return
  }
  socket.on('error', () => socket.destroy())
  pending.set(++nextId, { socket, sent: false })
  flush()
})
server.on('error', error => {
  process.send?.({ bound: false, error: { code: (error as NodeJS.ErrnoException).code ?? 'CONTROL_UNAVAILABLE', message: error.message } }, () => process.exit(1))
})
server.listen(path, async () => {
  let identity: { dev: number; ino: number } | undefined
  try {
    const stat = await lstat(path)
    identity = { dev: stat.dev, ino: stat.ino }
    await chmod(path, 0o600)
    process.send!({ identity }, error => { if (error) process.exit(1) })
  } catch (error) {
    process.send?.({ bound: true, identity, error: { code: (error as NodeJS.ErrnoException).code ?? 'CONTROL_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } }, () => process.exit(1))
  }
})
