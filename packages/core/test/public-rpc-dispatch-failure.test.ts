import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentMuxError } from '../src/errors.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function socketPath() {
  const root = await mkdtemp(join(tmpdir(), 'amux-dispatch-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return join(root, 'rpc.sock')
}
async function listen(server: Server, path: string) {
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(path, yes) })
  cleanup.push(() => new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())))
}
async function invoke(path: string) {
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  cleanup.push(() => client.dispose())
  return client.call('capsule.open', { capsuleId: '123456789ABC', operationId: 'original-open' }).then(
    result => ({ result, error: null }), error => ({ result: null, error: error as AgentMuxError }))
}

it('reports a Unix request that never connected as not applied without claiming Agent input bytes', async () => {
  const result = await invoke(await socketPath())
  expect(result.error).toMatchObject({ code: 'CONTROL_UNAVAILABLE',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
})

it('keeps a dispatched Unix request unknown when its original reply is lost', async () => {
  const path = await socketPath(), received: string[] = []
  const server = createServer(socket => socket.once('data', bytes => { received.push(bytes.toString()); socket.destroy() }))
  await listen(server, path)
  const result = await invoke(path)
  expect(received).toHaveLength(1)
  expect(JSON.parse(received[0]!)).toMatchObject({ method: 'capsule.open', params: { operationId: 'original-open' } })
  expect(result.error).not.toBeNull()
  expect(result.error?.controlFailure?.disposition).not.toBe('not_applied')
})

it('preserves an original owner refusal instead of replacing it with transport admission facts', async () => {
  const path = await socketPath()
  const server = createServer(socket => socket.once('data', bytes => {
    const request = JSON.parse(bytes.toString())
    socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Original owner refused.',
      data: { code: 'CONTROL_PERMISSION_DENIED',
        controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } } } }) + '\n')
  }))
  await listen(server, path)
  const result = await invoke(path)
  expect(result.error).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED', message: 'Original owner refused.',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
})
