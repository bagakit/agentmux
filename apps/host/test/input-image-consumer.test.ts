import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { fileUploadRevision } from '@agentmux/core/files'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../src/host.js'

const privateHome = vi.hoisted(() => ({ directory: undefined as string | undefined }))
vi.mock('node:os', async load => { const original = await load<typeof import('node:os')>(); return { ...original, homedir: () => privateHome.directory ?? original.homedir() } })
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
it('the default background Host retains and reopens original input image bytes without a Desktop', async () => {
  const original = await rpcOwnerFixture(['image-agent'], core); cleanup.push(original.close)
  privateHome.directory = original.root
  await original.client.dispose()
  const socketPath = join(original.root, 'image-host.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      inner.kernel.isConnected = () => false
    })
    try { host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile') }) }
    finally { connect.mockRestore() }
  }
  const stop = async () => { const current = host; host = undefined; await current?.dispose() }; cleanup.push(stop)
  const rpc = () => core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  await start()
  const reader = await rpc(); cleanup.push(() => reader.dispose())
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  const upload = { hostId: 'local', agentSessionId: 'image-agent', expectedRun: { runId: 'run-image-agent' }, operationId: 'selected-original-image', name: 'image', mimeType: 'image/png', byteLength: bytes.length, revision: fileUploadRevision(bytes) }
  expect(await reader.call('file.upload', { ...upload, dataBase64: bytes.toString('base64') })).toMatchObject({ status: 'uploaded' })
  const prompt = 'Read the selected image', inputImages = [{ start: 9, end: prompt.length, bodyRevision: fileUploadRevision(new TextEncoder().encode(prompt)), upload }]
  const input = { agentSessionId: upload.agentSessionId, expectedRun: upload.expectedRun, operationId: 'original-image-input', prompt, inputImages, admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
  const submitted = await reader.call('agent.input.submit', input)
  const resource = { key: submitted.key, index: 0, revision: upload.revision, maxBytes: bytes.length }
  const before = await reader.call('agent.input.resource', resource)
  expect(before).toMatchObject({ status: 'available', dataBase64: bytes.toString('base64') })
  await reader.dispose(); await stop(); await start()
  const reopened = await rpc(); cleanup.push(() => reopened.dispose())
  expect(await reopened.call('agent.input.resource', resource)).toEqual(before)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'agent', 'input', 'resource', '--input', '-'], objectCliEnvironment(original.root), JSON.stringify(resource))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(before)
  expect((await reopened.call('agent.input.inspect', { key: submitted.key })).input?.status).toBe('waiting')
}, 60000)
