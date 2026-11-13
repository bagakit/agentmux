import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AGENTMUX_RPC_NATIVE_METHODS } from '../src/public-rpc.js'
import { parseNativeDesktopParams } from '../src/public-rpc-native-desktop.js'
import { parseImageParams, parseImageResult, type AgentMuxRpcImageOwner, type ImageActor, type ImageCallContext,
  type ImageMethod, type ImageParamsMap, type ImageOperation, type ImageResult } from '../src/public-rpc-image.js'
import { agentMuxCliModuleCatalog, agentMuxModuleSkill } from '../src/agentmux-cli-module-skills.js'
import { agentMuxCommandHelp, AGENTMUX_CLI_HELP } from '../src/agentmux-cli-help.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'

const image = { format: 'png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', width: 1, height: 1, scale: 1 }
const actor: ImageActor = { kind: 'user', id: 'original-person' }
const context = { principal: actor }
const pin = { hostId: 'local', operationId: 'original-pin', image }
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function record(operationId = pin.operationId, originalActor = actor): ImageOperation {
  return { operationId, method: 'image.pin', actor: originalActor, pinId: 'original-image', state: 'completed', effect: 'opened', message: null }
}
function result(operation = record()): ImageResult {
  return { hostId: 'local', pinId: operation.pinId, state: 'open', creationOperationId: pin.operationId, recordedOperation: operation }
}
function ownerFixture() {
  const pins = new Map<string, ImageResult>(), operations = new Map<string, ImageResult>()
  const call = vi.fn(async (method: ImageMethod, input: ImageParamsMap[ImageMethod], callContext: ImageCallContext): Promise<ImageResult> => {
    if (method === 'image.inspect') {
      const found = input.operationId ? operations.get(input.operationId) : pins.get((input as { pinId: string }).pinId)
      if (!found) return { hostId: input.hostId, pinId: 'pinId' in input ? input.pinId! : null, state: 'missing', creationOperationId: null, recordedOperation: null }
      const current = found.pinId ? pins.get(found.pinId) : undefined
      return { ...found, state: current?.state ?? found.state, recordedOperation: input.operationId ? found.recordedOperation : null }
    }
    const operationId = input.operationId!
    if (operations.has(operationId)) return operations.get(operationId)!
    if (method === 'image.pin') {
      const output = { ...result(record(operationId, callContext.actor)), pinId: 'image-' + operationId, creationOperationId: operationId }
      output.recordedOperation!.pinId = output.pinId
      pins.set(output.pinId, output); operations.set(operationId, output); return output
    }
    const pinId = (input as ImageParamsMap['image.close']).pinId, existing = pins.get(pinId)
    const output: ImageResult = { hostId: input.hostId, pinId, state: existing ? 'closed' : 'missing', creationOperationId: existing?.creationOperationId ?? null,
      recordedOperation: { operationId, pinId, actor: callContext.actor, method, state: 'completed', effect: existing ? 'closed' : 'missing', message: null } }
    if (existing) pins.set(pinId, output)
    operations.set(operationId, output); return output
  })
  return { call, owner: { call } as AgentMuxRpcImageOwner }
}

it('typed image requests reject ambiguous selectors, external sources and non-pixel scales', () => {
  expect(parseImageParams('image.pin', pin)).toEqual(pin)
  for (const invalid of [{ ...pin, image: { ...image, scale: 2 } }, { ...pin, image: { ...image, width: 2 } },
    { ...pin, image: { ...image, data: 'not-a-png' } }, { ...pin, url: 'https://example.invalid/image.png' },
    { ...pin, actor }, { ...pin, operationId: '\0' }]) expect(() => parseImageParams('image.pin', invalid)).toThrow()
  for (const input of [{ hostId: 'local' }, { hostId: 'local', pinId: 'one', operationId: 'two' }])
    expect(() => parseImageParams('image.inspect', input)).toThrow()
  expect(() => parseImageParams('image.close', { hostId: 'local', operationId: 'close' })).toThrow()
  expect(parseNativeDesktopParams('native.clipboard.write', { hostId: 'local', instanceId: 'native-original', operationId: 'clipboard', format: 'png', data: image.data })).toMatchObject({ data: image.data })
})

it('a pin origin is an exact finite on-screen rectangle with a positive size', () => {
  const origin = { x: -1440, y: 25.5, width: 320, height: 200 }
  expect(parseImageParams('image.pin', { ...pin, origin })).toEqual({ ...pin, origin })
  expect(parseImageParams('image.pin', pin), 'origin stays optional').not.toHaveProperty('origin')
  for (const invalid of [{ ...origin, width: 0 }, { ...origin, height: -1 }, { ...origin, x: Number.NaN }, { ...origin, y: Number.POSITIVE_INFINITY },
    { ...origin, x: '1' }, { x: 1, y: 2, width: 3 }, { ...origin, display: 2 }, null])
    expect(() => parseImageParams('image.pin', { ...pin, origin: invalid }), JSON.stringify(invalid)).toThrow()
})

it('image result codec rejects foreign Host, pin, actor and original operation effects', () => {
  expect(parseImageResult('image.inspect', { ...result(), state: 'closed' }, { hostId: 'local', operationId: pin.operationId }, actor))
    .toMatchObject({ state: 'closed', recordedOperation: { effect: 'opened' } })
  expect(() => parseImageResult('image.pin', { ...result(), hostId: 'other' }, pin, actor)).toThrow()
  expect(() => parseImageResult('image.close', result(), { hostId: 'local', pinId: 'another', operationId: 'close' }, actor)).toThrow()
  expect(() => parseImageResult('image.pin', result(record(pin.operationId, { ...actor, id: 'another' })), pin, actor)).toThrow()
  expect(() => parseImageResult('image.inspect', { ...result(record('foreign')), creationOperationId: 'foreign' }, { hostId: 'local', operationId: pin.operationId }, actor)).toThrow()
  expect(() => parseImageResult('image.pin', result({ ...record(), state: 'unknown', message: 'Lost reply' }), pin, actor)).toThrow()
})

it('public service consumes the image owner and retains original authority at submission', async () => {
  const h = ownerFixture(), service = new AgentMuxRpcService({ coreClients: () => [], images: h.owner })
  await expect(service.call('image.pin', pin, context)).resolves.toMatchObject({ creationOperationId: pin.operationId })
  expect(h.call).toHaveBeenCalledOnce()
  const [method, input, original] = h.call.mock.calls[0]!
  expect(method).toBe('image.pin'); expect(input).toEqual(pin); expect(original.actor).toEqual(actor)
  let revoked = false
  const delayedOwner: AgentMuxRpcImageOwner = { async call(_method, _input, originalContext) {
    revoked = true; await originalContext.assertCurrent?.(); return result()
  } }
  const delayed = new AgentMuxRpcService({ coreClients: () => [], images: delayedOwner })
  await expect(delayed.call('image.pin', pin, { ...context, assertCurrent() { if (revoked) throw new Error('Original authority revoked') } })).rejects.toThrow('Original authority revoked')
})

it('only authenticated actors reach image effects and managed callers retain their exact Host', async () => {
  const h = ownerFixture(), service = new AgentMuxRpcService({ coreClients: () => [], images: h.owner })
  await expect(service.call('image.pin', pin)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.call).not.toHaveBeenCalled()
  const core = { authorizeRetainedAgentCaller: async () => ({ agentSessionId: 'original-agent', hostId: 'original-host' }) }
  const managed = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'original-host', client: core as never }], images: h.owner })
  await expect(managed.call('image.pin', pin, { caller: { agentSessionId: 'original-agent', capability: 'original-capability' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.call).not.toHaveBeenCalled()
})

it('forwarding keeps original image inputs and the authenticated transport context', async () => {
  const forward = vi.fn(async () => result()), service = new AgentMuxRpcService({ coreClients: () => [], forwardControl: forward as never })
  await expect(service.call('image.pin', pin, context)).resolves.toEqual(result())
  expect(forward).toHaveBeenCalledWith('image.pin', pin, context)
  const unavailable = new AgentMuxRpcService({ coreClients: () => [] })
  await expect(unavailable.call('image.inspect', { hostId: 'local', operationId: pin.operationId }, context)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})

it('unknown image effects and absent original records remain distinct without a retry', async () => {
  const unknown: ImageResult = { hostId: 'local', pinId: null, state: 'unknown', creationOperationId: pin.operationId,
    recordedOperation: { ...record(), pinId: null, state: 'unknown', effect: null, message: 'Original window acknowledgement is unavailable' } }
  const owner = { call: vi.fn(async () => unknown) }, service = new AgentMuxRpcService({ coreClients: () => [], images: owner as AgentMuxRpcImageOwner })
  await expect(service.call('image.pin', pin, context)).resolves.toEqual(unknown)
  expect(owner.call).toHaveBeenCalledOnce()
  const absent = { hostId: 'local', pinId: null, state: 'missing' as const, creationOperationId: null, recordedOperation: null }
  expect(parseImageResult('image.inspect', absent, { hostId: 'local', operationId: pin.operationId }, actor)).toEqual(absent)
})

it('image module is registered in aggregate discovery and actual help and skill readers', async () => {
  expect(Object.keys(AGENTMUX_RPC_NATIVE_METHODS)).toEqual(expect.arrayContaining(['image.pin', 'image.inspect', 'image.close']))
  expect(agentMuxCliModuleCatalog().some(module => module.root === 'image' && module.summary.includes('Temporary'))).toBe(true)
  expect(AGENTMUX_CLI_HELP).toContain('amux image')
  expect(agentMuxCommandHelp('image.inspect')).toContain('exactly one of operationId or pinId')
  expect(agentMuxModuleSkill('image')).toContain('recordedOperation')
  const directory = await mkdtemp(join(tmpdir(), 'amux-image-input-')), inputPath = join(directory, 'input.json')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(inputPath, JSON.stringify({ hostId: 'local', pinId: 'original-image' }))
  expect(await parseAgentMuxCliInvocation(['image', 'inspect', '--input', inputPath]))
    .toMatchObject({ command: { method: 'image.inspect' }, params: { hostId: 'local', pinId: 'original-image' } })
})

it('actual public client and CLI preserve current pin state and the separate original effect', async () => {
  const h = ownerFixture(), directory = await mkdtemp(join(tmpdir(), 'amux-image-')), endpoint = join(directory, 'rpc.sock')
  const server = new AgentMuxControlServer({ socketPath: endpoint, coreClients: () => [], images: h.owner })
  await server.start(); cleanups.push(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }) })
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: endpoint } }); cleanups.push(() => client.dispose())
  const opened = await client.call('image.pin', pin)
  expect(opened).toMatchObject({ state: 'open', creationOperationId: pin.operationId })
  const entry = process.env.IMAGE_PUBLIC_CLI
  expect(entry, 'verification must build the actual CLI').toBeTruthy()
  async function cli(action: string, input: unknown) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
      const child = spawn(process.execPath, [entry!, '--endpoint', 'unix:' + endpoint, 'image', action, '--input', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input))
    })
  }
  const closed = await cli('close', { hostId: 'local', pinId: opened.pinId, operationId: 'original-close' })
  expect(closed.code, closed.stdout + closed.stderr).toBe(0)
  expect(JSON.parse(closed.stdout).result).toMatchObject({ state: 'closed', recordedOperation: { effect: 'closed' } })
  const inspected = await cli('inspect', { hostId: 'local', operationId: pin.operationId })
  expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout).result).toMatchObject({ state: 'closed', recordedOperation: { operationId: pin.operationId, effect: 'opened' } })
  expect(h.call.mock.calls.filter(([method]) => method === 'image.pin')).toHaveLength(1)
  expect(await client.call('image.inspect', { hostId: 'local', pinId: opened.pinId! })).toMatchObject({ state: 'closed', recordedOperation: null })
  h.call.mockImplementationOnce(async (_method, _input, original) => ({ hostId: 'local', pinId: null, state: 'unknown', creationOperationId: 'unknown-pin',
    recordedOperation: { operationId: 'unknown-pin', method: 'image.pin', actor: original.actor, pinId: null, state: 'unknown', effect: null, message: 'Original presentation acknowledgement is unavailable' } }))
  const unknown = await cli('pin', { ...pin, operationId: 'unknown-pin' })
  expect(unknown.code, unknown.stdout + unknown.stderr).toBe(1)
  expect(JSON.parse(unknown.stdout).result).toMatchObject({ state: 'unknown', recordedOperation: { operationId: 'unknown-pin', effect: null } })
  expect(h.call.mock.calls.filter(([method, input]) => method === 'image.pin' && input.operationId === 'unknown-pin')).toHaveLength(1)
})

it('accepts a missing close effect beside a closed pin and still refuses it beside an open window', () => {
  const close = { hostId: 'local', pinId: 'original-image', operationId: 'later-close' }
  const missing: ImageOperation = { operationId: 'later-close', method: 'image.close', actor, pinId: 'original-image', state: 'completed', effect: 'missing', message: null }
  const receipt = (state: ImageResult['state']): ImageResult => ({ hostId: 'local', pinId: 'original-image', state,
    creationOperationId: state === 'missing' ? null : pin.operationId, recordedOperation: missing })
  expect(parseImageResult('image.close', receipt('closed'), close, actor)).toMatchObject({ state: 'closed', recordedOperation: { effect: 'missing' } })
  expect(parseImageResult('image.close', receipt('missing'), close, actor)).toMatchObject({ state: 'missing' })
  expect(() => parseImageResult('image.close', receipt('open'), close, actor)).toThrow('An absent image effect cannot claim a current window.')
})
