import { fixtureDisplayPath as reshapeFixtureDisplayPath, fixtureEpoch as reshapeFixtureEpoch, fixturePath as reshapeFixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxControlServer, connectAgentMuxRpc, parseAgentMuxControlReceipt } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, agentMuxControlTimeoutMs } from '../src/control.js'
import { AgentMuxRpcService, type AgentMuxRpcServiceOptions } from '../src/public-rpc-service.js'
import { parseToolkitCommand } from '../src/toolkit-cli.js'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import {
  parseToolkitPackageManifest, parseToolkitRequest, parseToolkitResult, parseToolkitSnapshot,
  parseToolkitToolDefinition, parseToolkitToolFields,
  type AgentMuxToolkitPort, type ToolkitAdmission, type ToolkitConfirmedResult,
  type ToolkitDescriptor, type ToolkitRequest, type ToolkitResult, type ToolkitScriptSnapshot,
  type ToolkitSubscribeOptions, type ToolkitToolDefinition
} from '../src/toolkit.js'

const definition: ToolkitToolDefinition = { id: 'report', revision: 'one', name: 'Report', icon: 'terminal',
  enabled: true, statusBar: 'icon', workspacePath: reshapeFixturePath("project"), script: "console.log('action')", args: [],
  display: { script: "console.log('current')", args: ['--current'] },
  actions: [{ id: 'change', label: 'Change', script: "console.log('changed')", args: [] }] }
const input = { invocationId: 'display-request', expectedRevision: 'one', expectedLatestExecutionId: 'display-original' }
const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'request-one' } as const
const execution = { executionId: 'display-original', invocationId: 'display-earlier', definition,
  expectedLatestExecutionId: null, target: { workspacePath: definition.workspacePath },
  run: { hostId: 'local', runId: 'display-run' }, startedAt: reshapeFixtureEpoch(0, 0, 1), text: 'Current value' }
const confirmed: ToolkitConfirmedResult = { ...execution, state: 'succeeded', reason: null, endedAt: reshapeFixtureEpoch(0, 0, 2), exitCode: 0 }
const actionUnknown: ToolkitAdmission = { ...execution, executionId: 'unknown-action', invocationId: 'action-request',
  expectedLatestExecutionId: 'action-original', run: null, state: 'unknown', reason: 'Original action receipt missing',
  action: { id: 'change', sourceExecutionId: 'action-original', expectedAdmissionExecutionId: null } }
const snapshot = (): ToolkitScriptSnapshot => ({ schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id,
  definition, state: 'unknown', reason: actionUnknown.reason, admission: actionUnknown, latestConfirmed: null,
  consumerCount: 0, sequence: 3, display: { state: 'succeeded', reason: null, admission: null, latestConfirmed: confirmed, sequence: 2 } })
const descriptor = (readonly = false): ToolkitDescriptor => ({ kind: 'script', toolId: definition.id,
  name: definition.name, readonly, revision: definition.revision, icon: definition.icon, enabled: true, statusBar: 'icon', display: true })
const tools = (readonly = false): ToolkitDescriptor[] => [{ kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true }, descriptor(readonly)]
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'toolkit-display-core-')); cleanups.push(() => rm(root, { recursive: true, force: true })); return root }
async function socket(port: AgentMuxToolkitPort) {
  const path = join(await directory(), 'toolkit.sock'), server = new AgentMuxControlServer({ coreClients: () => [], toolkit: port }, path)
  await server.start(); cleanups.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanups.push(() => client.dispose())
  return client
}
const owner = (request: ToolkitRequest): ToolkitResult => {
  if (request.operation === 'toolkit.list') return { operation: request.operation, tools: tools() }
  if (request.operation === 'toolkit.get' || request.operation === 'toolkit.evaluate') return { operation: request.operation, snapshot: snapshot() }
  throw new Error(`Unexpected owner operation ${request.operation}`)
}

describe('Toolkit declared display evaluation public contract', () => {
  it('admits an optional bounded inline display program and explicit null removal', () => {
    const { id: _id, revision: _revision, ...fields } = definition
    expect(parseToolkitToolFields(fields)).toEqual(fields)
    expect(parseToolkitToolFields({ display: null }, true)).toEqual({ display: null })
    expect(() => parseToolkitToolFields({ ...fields, display: { script: 'ready' } })).toThrow()
    expect(() => parseToolkitToolFields({ ...fields, display: { ...fields.display, workspacePath: reshapeFixturePath("other") } })).toThrow()
    expect(() => parseToolkitToolFields({ ...fields, script: 'a'.repeat(28_000), display: { script: 'b'.repeat(16_000), args: [] } })).toThrow()
    expect(() => parseToolkitToolFields({ ...fields, display: { script: 'ready', args: ['bad\0arg'] } })).toThrow()
    expect(rpcControlRequest('toolkit.update', { toolId: definition.id, input: { changes: { display: null }, expected: { display: definition.display } } }))
      .toMatchObject({ changes: { display: null }, expected: { display: definition.display } })
  })
  it('validates a manifest display entry and binds resolved package display source', () => {
    const manifest = { schema: 'agentmux.toolkit.package.v1', name: 'Report', icon: 'terminal', entry: 'run.mjs', display: { entry: 'display.mjs' } }
    expect(parseToolkitPackageManifest(manifest)).toEqual({ ...manifest, actions: [], display: { entry: 'display.mjs', args: [] } })
    for (const entry of [(".." + reshapeFixtureDisplayPath("outside.mjs")), reshapeFixtureDisplayPath("outside.mjs"), 'nested//display.mjs']) expect(() => parseToolkitPackageManifest({ ...manifest, display: { entry } })).toThrow()
    expect(() => parseToolkitPackageManifest({ ...manifest, display: null })).toThrow()
    const source = { path: reshapeFixturePath("package"), configRevision: 'config', contentSHA256: 'a'.repeat(64), entry: 'run.mjs',
      actionEntries: [{ id: 'change', entry: 'change.mjs' }], displayEntry: 'display.mjs' }
    expect(parseToolkitToolDefinition({ ...definition, package: source })).toMatchObject({ package: source })
    const { displayEntry: _displayEntry, ...without } = source
    expect(() => parseToolkitToolDefinition({ ...definition, package: without })).toThrow()
    expect(() => parseToolkitToolDefinition({ ...definition, display: null, package: source })).toThrow()
  })
  it('keeps confirmed display facts separate from an unknown action and retains them after declaration removal', () => {
    expect(parseToolkitSnapshot(snapshot())).toEqual(snapshot())
    const retained = { ...snapshot(), definition: { ...definition, display: null } }
    expect(parseToolkitSnapshot(retained)).toEqual(retained)
    const unavailable = { schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: definition.id,
      configuration: { kind: 'package', id: definition.id, revision: 'config', packagePath: reshapeFixturePath("package"), enabled: true, statusBar: 'icon', workspacePath: reshapeFixturePath("project"), args: [] },
      reason: 'Source unavailable', retained }
    const receipt = { ...base, operation: 'toolkit.evaluate', ok: true, result: { snapshot: unavailable } }
    expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
    expect(() => parseToolkitSnapshot({ ...retained, display: { state: 'idle', reason: null, admission: null, latestConfirmed: null, sequence: 0 } })).toThrow()
  })
  it('rejects display facts without their captured declaration, another tool, an action or a nested snapshot', () => {
    for (const latestConfirmed of [
      { ...confirmed, definition: { ...definition, display: null } },
      { ...confirmed, definition: { ...definition, id: 'another' } },
      { ...confirmed, expectedLatestExecutionId: 'action-original', action: actionUnknown.action }
    ]) expect(() => parseToolkitSnapshot({ ...snapshot(), display: { ...snapshot().display, latestConfirmed } })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), display: snapshot() })).toThrow()
    expect(() => parseToolkitSnapshot({ ...snapshot(), display: { ...snapshot().display, state: 'failed' } })).toThrow()
    const getter = vi.fn(() => confirmed)
    const display = Object.defineProperty({ ...snapshot().display }, 'latestConfirmed', { enumerable: true, get: getter })
    expect(() => parseToolkitSnapshot({ ...snapshot(), display })).toThrow(); expect(getter).not.toHaveBeenCalled()
  })
  it('keeps the last successful display through a later failure and a full unavailable-package receipt', () => {
    const source = { path: reshapeFixturePath("package"), configRevision: 'config', contentSHA256: 'a'.repeat(64), entry: 'run.mjs',
      actionEntries: [{ id: 'change', entry: 'change.mjs' }], displayEntry: 'display.mjs' }
    const captured = { ...definition, package: source }
    const lastSucceeded = { ...confirmed, definition: captured }
    const latestConfirmed: ToolkitConfirmedResult = { ...lastSucceeded, executionId: 'later-failed',
      invocationId: 'later-request', state: 'failed', reason: 'Display failed', endedAt: reshapeFixtureEpoch(0, 0, 3), exitCode: 1 }
    const retained = { ...snapshot(), definition: captured,
      display: { state: 'failed', reason: latestConfirmed.reason, admission: null, latestConfirmed, lastSucceeded, sequence: 4 } }
    const unavailable = { schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: definition.id,
      configuration: { kind: 'package', id: definition.id, revision: 'config', packagePath: reshapeFixturePath("package"), enabled: true, statusBar: 'icon', workspacePath: reshapeFixturePath("project"), args: [] },
      reason: 'Source unavailable', retained }
    const receipt = { ...base, operation: 'toolkit.get', ok: true, result: { snapshot: unavailable } }
    expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
    expect(() => parseToolkitSnapshot({ ...retained, display: { ...retained.display, lastSucceeded: latestConfirmed } })).toThrow()
  })
  it('discovers declared display programs without inventing a metrics display lane', () => {
    expect(parseToolkitResult('toolkit.list', { tools: tools() })).toMatchObject({ tools: [expect.anything(), { display: true }] })
    expect(() => parseToolkitResult('toolkit.list', { tools: [{ ...tools()[0], display: true }, descriptor()] })).toThrow()
    expect(() => parseToolkitResult('toolkit.list', { tools: [tools()[0], { ...descriptor(), display: 'yes' }] })).toThrow()
  })
  it('requires complete display invocation scope while watch evaluation remains an explicit Boolean opt-in', () => {
    const request = { ...base, operation: 'toolkit.evaluate', toolId: definition.id, input }
    expect(parseToolkitRequest(request)).toEqual(request)
    expect(parseToolkitRequest({ ...base, operation: 'toolkit.evaluate', toolId: definition.id })).toMatchObject({ operation: 'toolkit.evaluate' })
    expect(() => parseToolkitRequest({ ...request, toolId: 'performance' })).toThrow()
    expect(() => parseToolkitRequest({ ...request, input: { ...input, expectedLatestExecutionId: undefined } })).toThrow()
    for (const evaluateOnDisplay of [true, false]) expect(parseToolkitRequest({ ...base, operation: 'toolkit.watch', toolId: definition.id, evaluateOnDisplay })).toMatchObject({ evaluateOnDisplay })
    expect(parseToolkitRequest({ ...base, operation: 'toolkit.watch', toolId: 'performance', evaluateOnDisplay: true, captureFailure: true })).toMatchObject({ captureFailure: true, evaluateOnDisplay: true })
    expect(() => parseToolkitRequest({ ...base, operation: 'toolkit.watch', toolId: definition.id, evaluateOnDisplay: 'yes' })).toThrow()
    expect(() => parseToolkitRequest({ ...base, operation: 'toolkit.get', toolId: definition.id, evaluateOnDisplay: true })).toThrow()
    expect(agentMuxControlTimeoutMs('toolkit.evaluate')).toBe(agentMuxControlTimeoutMs('toolkit.run'))
  })
  it('registers actual evaluate and watch --evaluate CLI carriers with unchanged Performance flags', async () => {
    const file = join(await directory(), 'input.json'); await writeFile(file, JSON.stringify(input))
    expect(await parseToolkitCommand(['evaluate', definition.id, '--input', file])).toEqual({ method: 'toolkit.evaluate', params: { toolId: definition.id, input } })
    expect((await parseAgentMuxCliInvocation(['toolkit', 'evaluate', definition.id])).params).toEqual({ toolId: definition.id })
    expect((await parseAgentMuxCliInvocation(['toolkit', 'watch', definition.id, '--evaluate'])).params).toEqual({ toolId: definition.id, evaluateOnDisplay: true })
    expect(await parseToolkitCommand(['watch', 'performance', '--evaluate', '--capture-failure', '--failure-evidence'])).toMatchObject({ params: { evaluateOnDisplay: true, captureFailure: true, includeFailureEvidence: true } })
    await expect(parseToolkitCommand(['watch', definition.id, '--evaluate', '--evaluate'])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    await expect(parseToolkitCommand(['watch', definition.id, '--capture-failure'])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    expect(agentMuxCommandHelp('toolkit.evaluate')).toContain('independent baseline')
    expect(agentMuxCommandHelp('toolkit.watch')).toContain('--evaluate')
    expect(AGENTMUX_CLI_SKILL).toContain('Ordinary inspect and watch never evaluate.')
  })
  it('leaves automatic evaluation capture with the original owner through a real Unix socket and preserves pinned scope', async () => {
    const execute = vi.fn(async (request: ToolkitRequest) => owner(request))
    const client = await socket({ execute, subscribe: vi.fn() })
    expect(await client.call('toolkit.evaluate', { operationId: base.requestId, toolId: definition.id })).toEqual({ snapshot: snapshot() })
    expect(execute.mock.calls.map(([request]) => request.operation)).toEqual(['toolkit.evaluate'])
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty('input')
    execute.mockClear()
    await client.call('toolkit.evaluate', { toolId: definition.id, input })
    expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0]?.[0]).toMatchObject({ input })
  })
  it('rejects an explicit evaluate without a declaration without touching its original facts', async () => {
    const { display: _display, ...passive } = definition
    const execute = vi.fn(async (request: ToolkitRequest): Promise<ToolkitResult> => {
      if (request.operation === 'toolkit.evaluate') throw new AgentMuxError('No declared display entry.', 'SETTING_RESOURCE_NOT_FOUND')
      return { operation: 'toolkit.get', snapshot: { ...snapshot(), definition: passive } }
    })
    const client = await socket({ execute, subscribe: vi.fn() })
    await expect(client.call('toolkit.evaluate', { toolId: definition.id })).rejects.toMatchObject({ code: 'SETTING_RESOURCE_NOT_FOUND' })
    expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0]?.[0].operation).toBe('toolkit.evaluate')
  })
  it('carries explicit reader evaluation to the owner through a real Unix socket, keeping plain watch passive', async () => {
    const options: ToolkitSubscribeOptions[] = [], release = vi.fn(), execute = vi.fn(async (request: ToolkitRequest) => owner(request))
    const client = await socket({ execute, subscribe: async (_id, publish, _end, _signal, supplied = {}) => {
      options.push(supplied); publish(snapshot()); return { dispose: release }
    } })
    for (const params of [{ toolId: definition.id }, { toolId: definition.id, evaluateOnDisplay: true }]) {
      const publish = vi.fn(), lease = await client.subscribe('toolkit.watch', params, { onInitial: vi.fn(), onEvent: publish, onEnd: vi.fn() })
      await vi.waitFor(() => expect(publish).toHaveBeenCalledWith({ type: 'snapshot', data: snapshot() })); await lease.dispose()
    }
    expect(options).toEqual([{}, { evaluateOnDisplay: true }]); expect(execute).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
  })
  it('keeps official evaluate and opt-in readers behind local-user authority before forwarding', async () => {
    const forwarded = vi.fn(async (method: string) => method === 'toolkit.ls' ? { tools: tools(true) } : { snapshot: snapshot() })
    const forwardSubscription = vi.fn(async (_method: string, _params: unknown, callbacks: { onInitial(value: { toolId: string }): void }) => { callbacks.onInitial({ toolId: definition.id }); return { dispose: vi.fn() } })
    const service = new AgentMuxRpcService({ coreClients: () => [], forwardControl: forwarded as NonNullable<AgentMuxRpcServiceOptions['forwardControl']>,
      forwardSubscription: forwardSubscription as NonNullable<AgentMuxRpcServiceOptions['forwardSubscription']> })
    cleanups.push(() => service.dispose())
    const remote = { transport: 'http' as const, principal: { kind: 'user' as const, id: 'local-person' } }
    await expect(service.call('toolkit.evaluate', { toolId: definition.id, input }, remote)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.subscribe('toolkit.watch', { toolId: definition.id, evaluateOnDisplay: true }, vi.fn(), remote)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(forwarded.mock.calls.map(([method]) => method)).toEqual(['toolkit.ls', 'toolkit.ls']); expect(forwardSubscription).not.toHaveBeenCalled()
    const plain = await service.subscribe('toolkit.watch', { toolId: definition.id }, vi.fn(), remote); await plain.dispose()
    expect(forwardSubscription).toHaveBeenCalledOnce()
    const local = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'person' } }
    await expect(service.call('toolkit.evaluate', { toolId: definition.id, input }, local)).resolves.toEqual({ snapshot: snapshot() })
    const enabled = await service.subscribe('toolkit.watch', { toolId: definition.id, evaluateOnDisplay: true }, vi.fn(), local); await enabled.dispose()
    expect(forwarded.mock.calls.at(-1)?.[0]).toBe('toolkit.evaluate'); expect(forwardSubscription.mock.calls.at(-1)?.[1]).toEqual({ toolId: definition.id, evaluateOnDisplay: true })
  })
})
