import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { once } from 'node:events'
import { AgentMuxError } from './errors.js'

const PATH_ENV = 'AGENTMUX_TOOLKIT_RESULT_PATH'
const TOKEN_ENV = 'AGENTMUX_TOOLKIT_RESULT_TOKEN'
const error = (message: string) => new AgentMuxError(message, 'TOOLKIT_RESULT_CHANNEL_FAILED')
/** A Toolkit capability, not a Run transport. No process or Run is owned here.
 * One authenticated byte stream; the consumer owns framing and backpressure.
 */
export async function openToolkitResultChannel(args: {
  onBytes(bytes: Uint8Array): Promise<void> | void
  onEnd(): void
  onError(error: unknown): void
}) {
  // A short private path also fits macOS sockaddr_un, independent of TMPDIR length.
  const directory = await mkdtemp('/tmp/amxt-')
  await chmod(directory, 0o700)
  const path = join(directory, 'result.sock'), token = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  let authenticated = false, closing = false, closeWork: Promise<void> | null = null
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    void (async () => {
      let header = Buffer.alloc(0), accepted = false
      try {
        for await (const part of socket) {
          let bytes: Buffer = part
          if (!accepted) {
            const newline = bytes.indexOf(10)
            const head = bytes.subarray(0, newline < 0 ? bytes.length : newline)
            if (header.length + head.length > 64) return
            header = Buffer.concat([header, head])
            if (newline < 0) continue
            const expected = Buffer.from(token)
            if (header.length !== expected.length || !timingSafeEqual(header, expected) || authenticated) return
            authenticated = accepted = true
            socket.write(Buffer.from([1]))
            bytes = bytes.subarray(newline + 1)
          }
          if (bytes.length) await args.onBytes(bytes)
        }
        if (accepted && !closing) args.onEnd()
      } catch (failure) { if (accepted && !closing) args.onError(failure) }
      finally { socket.destroy() }
    })()
  })
  // Handshakes retain <=64 bytes each. A rejected client never consumes the capability.
  server.maxConnections = 2
  const listening = once(server, 'listening')
  server.listen(path)
  try { await listening; await chmod(path, 0o600) }
  catch (failure) { server.close(); await rm(directory, { recursive: true, force: true }); throw failure }
  server.on('error', failure => { if (!closing) args.onError(failure) })
  return {
    env: { [PATH_ENV]: path, [TOKEN_ENV]: token },
    close(): Promise<void> {
      return closeWork ??= (async () => {
        closing = true
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve, reject) => server.close(failure => failure ? reject(failure) : resolve()))
        await rm(directory, { recursive: true, force: true })
      })()
    }
  }
}
/** Explicit result capability. Never falls back to stdout/PTY or discovers another execution. */
export async function connectToolkitResultChannel(env: NodeJS.ProcessEnv = process.env): Promise<Socket> {
  const path = env[PATH_ENV], token = env[TOKEN_ENV]
  // Do not leak this one-execution credential into commands spawned by the script.
  delete env[PATH_ENV]; delete env[TOKEN_ENV]
  if (!path || !token || !/^[a-f0-9]{64}$/u.test(token)) throw error('Toolkit result capability is unavailable.')
  const socket = createConnection(path)
  try {
    await once(socket, 'connect')
    socket.write(token + '\n')
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const clean = () => { socket.off('data', data); socket.off('error', failed); socket.off('close', closed) }
      const data = (bytes: Buffer) => { clean(); resolve(bytes) }
      const failed = (failure: Error) => { clean(); reject(failure) }
      const closed = () => { clean(); reject(error('Toolkit result capability closed before acceptance.')) }
      socket.once('data', data); socket.once('error', failed); socket.once('close', closed)
    })
    if (reply.length !== 1 || reply[0] !== 1) throw error('Toolkit result capability was not accepted.')
    return socket
  } catch (failure) { socket.destroy(); throw failure }
}
