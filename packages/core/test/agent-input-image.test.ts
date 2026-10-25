import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { FileUploadOwner } from '../../../apps/host/src/file-upload-owner.js'
import { fileUploadRevision } from '../src/public-rpc-files.js'
import { parseAgentInputResourceResult } from '../src/agent-input-resource.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { encodeSelectedImageReference, expandComposerInput, expandSemanticReferences, editComposerInputImages, restoreComposerInput } from '../../client-ui/src/lib/composer-semantic-reference.js'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
class InputImageClient extends AgentMuxClient {
  readonly images: FileUploadOwner
  constructor(options: { store: AgentMuxAgentSessionStore }) {
    const images = new FileUploadOwner(join(process.env.AGENTMUX_STATE_DIRECTORY!, 'images'))
    super({ ...options, inputResources: images }); this.images = images
  }
}
async function fixture() {
  const h = await rpcOwnerFixture(['recipient', 'other'], { AgentMuxClient: InputImageClient, AgentMuxFileAgentSessionStore }); cleanup.push(h.close)
  h.inner.connected = false; h.inner.kernel.isConnected = () => false
  const upload = { hostId: 'local', agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'selected-image', name: 'image', mimeType: 'image/png', byteLength: png.length, revision: fileUploadRevision(png) }
  expect(await h.client.images.upload({ ...upload, dataBase64: png.toString('base64') })).toMatchObject({ status: 'uploaded' })
  const native = '@' + join(h.root, 'image.png'), draft = 'Please inspect ' + encodeSelectedImageReference(native, upload)
  const expanded = expandComposerInput(draft)
  const input = { agentSessionId: 'recipient', expectedRun: upload.expectedRun, operationId: 'original-input', prompt: expanded.text, inputImages: expanded.inputImages,
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const, authorHuman: true, sourceChannel: 'message-tool' as const }
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: upload.expectedRun, submissionId: input.operationId }
  const read = { key, index: 0, revision: upload.revision, maxBytes: png.length }
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients })
  return { ...h, upload, draft, native, expanded, input, key, read, rpc }
}
it('keeps a selected draft image in the original input journal and reads identical bytes through public RPC and Hosted SDK', async () => {
  const h = await fixture()
  expect(expandSemanticReferences(h.draft)).toBe(h.expanded.text)
  expect(h.expanded.inputImages).toHaveLength(1)
  await h.client.submitAgentPrompt(h.input)
  const mailbox = await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })
  expect(mailbox.items[0]).toMatchObject({ kind: 'item', item: { intent: { source: { inputImages: [{ observation: 'confirmed' }] } } } })
  const first = await h.rpc.call('agent.input.resource', h.read, { principal: { kind: 'user', id: 'reader' } })
  expect(parseAgentInputResourceResult(first, h.read)).toMatchObject({ status: 'available', dataBase64: png.toString('base64'), width: 1, height: 1 })
  const path = join(h.root, 'image-reader.sock'), service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => hostedTestOwner(h.client))
  cleanup.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: h.coreClients, hostedRuntime: () => service }); await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc, waitForReady: false }); cleanup.push(() => hosted.dispose())
  expect(await hosted.readAgentInputResource(h.read)).toEqual(first)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + path, 'agent', 'input', 'resource', '--input', '-'], objectCliEnvironment(h.root), JSON.stringify(h.read))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toEqual(first)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await h.client.submitAgentPrompt(h.input)
  expect((await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(1)
  await expect(h.client.submitAgentPrompt({ ...h.input, inputImages: [{ ...h.input.inputImages[0]!, upload: { ...h.upload, operationId: 'replacement' } }] })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
})
it('keeps the ordinary input when selected bytes are missing and never grants reads from a typed path or forged image token', async () => {
  const h = await fixture(), inspect = vi.spyOn(h.client.images, 'inspect'), read = vi.spyOn(h.client.images, 'read')
  const plain = expandComposerInput(h.native)
  expect(plain.inputImages).toEqual([])
  await h.client.submitAgentPrompt({ ...h.input, inputImages: [{ ...h.input.inputImages[0]!, upload: { ...h.upload, operationId: 'missing-original' } }] })
  expect((await h.client.inspectAgentInput({ key: h.key }))?.status).toBe('waiting')
  expect(await h.client.readAgentInputResource(h.read)).toMatchObject({ status: 'unavailable' })
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'missing-original' }), png.length)
  inspect.mockClear()
  await h.client.submitAgentPrompt({ ...h.input, operationId: 'wrong-run-image', inputImages: [{ ...h.input.inputImages[0]!, upload: { ...h.upload, expectedRun: { runId: 'other-run' } } }] })
  expect(inspect).not.toHaveBeenCalled()
  expect((await h.client.readAgentInputMailbox({ agentSessionId: 'recipient' })).items).toHaveLength(2)
})
it('refuses foreign membership, revision, caller and oversized bytes without replaying input', async () => {
  const h = await fixture(); await h.client.submitAgentPrompt(h.input)
  for (const read of [{ ...h.read, index: 1 }, { ...h.read, maxBytes: png.length - 1 }, { ...h.read, revision: fileUploadRevision(new Uint8Array([1])) }]) expect(await h.client.readAgentInputResource(read)).toMatchObject({ status: 'unavailable' })
  await expect(h.client.readAgentInputResource(h.read, { agentSessionId: 'other', capability: h.capability })).rejects.toMatchObject({ code: 'MESSAGE_SENDER_MISMATCH' })
  const receipt = await h.client.readAgentInputResource(h.read)
  expect(() => parseAgentInputResourceResult({ ...receipt, index: 1 }, h.read)).toThrow()
  expect(() => parseAgentInputResourceResult({ ...receipt, dataBase64: png.subarray(1).toString('base64') }, h.read)).toThrow()
  expect((await h.client.inspectAgentInput({ key: h.key }))?.status).toBe('waiting')
})

it('preserves a malformed image token and bounds encoded data before decoding any bytes', async () => {
  const malformed = '[Image](agentmux-image:%7B%22text%22%3A%22%40image.png%22%7D)'
  expect(expandComposerInput(malformed)).toEqual({ text: malformed, inputImages: [] })
  expect(expandSemanticReferences(malformed)).toBe(malformed)
  const h = await fixture(); await h.client.submitAgentPrompt(h.input)
  const receipt = await h.client.readAgentInputResource(h.read), decode = vi.spyOn(globalThis, 'atob')
  expect(() => parseAgentInputResourceResult({ ...receipt, byteLength: 1, dataBase64: 'A'.repeat(4 * Math.ceil(h.read.maxBytes / 3) + 4) }, h.read)).toThrow(/byte budget/)
  expect(decode).not.toHaveBeenCalled()
})

it('observes a late original upload without replacing the input or repeating the upload', async () => {
  const h = await fixture(), upload = { ...h.upload, operationId: 'late-upload' }
  await h.client.submitAgentPrompt({ ...h.input, inputImages: [{ ...h.input.inputImages[0]!, upload }] })
  expect(await h.client.readAgentInputResource(h.read)).toMatchObject({ status: 'unavailable' })
  const before = await h.client.inspectAgentInput({ key: h.key })
  await h.client.images.upload({ ...upload, dataBase64: png.toString('base64') })
  const send = vi.spyOn(h.client.images, 'upload')
  expect(await h.rpc.call('agent.input.resource', h.read, { principal: { kind: 'user', id: 'reader' } })).toMatchObject({ status: 'available', dataBase64: png.toString('base64') })
  expect(await h.client.inspectAgentInput({ key: h.key })).toEqual(before)
  expect(send).not.toHaveBeenCalled()
})

it('retains only the original selected images through adjacent queue text edits and a restored draft', async () => {
  const h = await fixture(), previous = h.expanded.text, next = 'Extra words before ' + previous + ' and after'
  const images = editComposerInputImages(previous, next, h.expanded.inputImages)!
  expect(images).toHaveLength(1)
  expect(next.slice(images[0]!.start, images[0]!.end)).toBe(h.native)
  expect(expandComposerInput(restoreComposerInput(next, images))).toEqual({ text: next, inputImages: images })
  expect(editComposerInputImages(previous, 'Extra unrelated @image.png words', h.expanded.inputImages)).toEqual([])
  await h.client.submitAgentPrompt({ ...h.input, prompt: next, inputImages: images })
  expect(await h.client.readAgentInputResource(h.read)).toMatchObject({ status: 'available' })
})
