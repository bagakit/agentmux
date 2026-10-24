import { createServer } from 'node:net'
import { chmod, lstat } from 'node:fs/promises'

// Own only listener admission. Core receives each Socket and owns all RPC semantics.
// Exit closes the named handle through the kernel without libuv's pathname unlink;
// Core separately removes only its verified inode. Never transfer a Unix Server:
// Node's receive path wraps its FD twice and leaves a stale Pipe owner on shutdown.
const path = process.argv[2]
if (!path || !process.send) process.exit(1)
process.once('disconnect', () => process.exit(1))
const pending = new Set<import('node:net').Socket>()
let nextId = 0, sending = false
function flush(): void {
  if (sending) return
  const socket = pending.values().next().value
  if (!socket) return
  pending.delete(socket); sending = true
  // Node's send callback owns IPC flow control; a later business ACK does not
  // represent another descriptor or authorize rejecting unrelated connections.
  process.send!({ connection: ++nextId }, socket, { keepOpen: false }, error => {
    sending = false
    if (error) { socket.destroy(); process.exit(1) }
    flush()
  })
}
const server = createServer({ pauseOnConnect: true }, socket => {
  socket.on('error', () => socket.destroy())
  socket.once('close', () => pending.delete(socket))
  pending.add(socket)
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
