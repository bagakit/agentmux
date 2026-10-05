import { createServer } from 'node:net'
import { chmod, lstat } from 'node:fs/promises'

// Only creates a private transport handle. The semantic owner accepts requests.
// Exit closes the named libuv handle through the kernel, without uv_pipe_close's
// pathname unlink. The receiving owner gets an unnamed IPC handle and owns cleanup.
const path = process.argv[2]
if (!path || !process.send) process.exit(1)
process.once('disconnect', () => process.exit(1))
const server = createServer()
server.on('error', error => {
  process.send?.({ bound: false, error: { code: (error as NodeJS.ErrnoException).code ?? 'CONTROL_UNAVAILABLE', message: error.message } }, () => process.exit(1))
})
server.listen(path, async () => {
  let identity: { dev: number; ino: number } | undefined
  try {
    const stat = await lstat(path)
    identity = { dev: stat.dev, ino: stat.ino }
    await chmod(path, 0o600)
    process.on('message', message => { if (message === 'adopted') process.exit(0) })
    process.send!({ identity }, server, { keepOpen: true }, error => { if (error) process.exit(1) })
  } catch (error) {
    process.send?.({ bound: true, identity, error: { code: (error as NodeJS.ErrnoException).code ?? 'CONTROL_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } }, () => process.exit(1))
  }
})
