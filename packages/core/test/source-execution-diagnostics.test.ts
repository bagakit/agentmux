import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxRpcResult } from '../src/public-rpc.js'
import type { AgentExecutionInspection } from '../src/agent-execution-coordinator.js'
import type { AgentExecutionSourceDiagnostics } from '../src/agent-execution-source-diagnostics.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sourceCreationFixture } from './helpers/source-creation-fixture.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { inspectSourceExecutionDiagnostics } from '../src/agent-execution-source-diagnostics.js'
import { parseRpcControlResult } from '../src/rpc-business-codec.js'
import { AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE } from '../src/spatial-agent-open.js'
const releases: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of releases.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(legacyBindingDigest = false) {
  const owner = await rpcOwnerFixture(['managed-observer']); releases.push(owner.close)
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_NOTE', { realBindings: true, legacyBindingDigest, coreClients: owner.coreClients })
  const input = { ...f.input, content: { ...f.input.content, prompt: 'PRIVATE_FIRST_INPUT' } }
  let original!: AgentMuxRpcResult<'agent.open'>, initialError: unknown
  try { original = await f.rpc.call('agent.open', input) } catch (error) { initialError = error }
  expect(initialError, 'The original Source result must satisfy its safe public contract').toBeUndefined()
  f.prepare.mockClear(); f.starts.mockClear(); f.create.mockClear(); f.agentInput.mockClear()
  return { ...f, input, original, owner }
}
it('an authenticated managed Source CLI reads original safe journal metadata without full binding authority or any effect', async () => {
  const f = await fixture()
  const projection = await f.runtime.executionBindings.sourceDiagnostics!(f.input.operationId)
  expect(JSON.stringify(projection)).not.toContain('PRIVATE_')
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: f.owner.credentials })
  const report = result.request!.report!
  expect(report.execution).toMatchObject({ reference: f.original.execution!.reference, inspection: null,
    diagnostics: { sourceRuntimeId: 'runtime-b', state: 'matched', reference: f.original.execution!.reference,
      helpers: { executor: { start: { outcome: 'not-submitted', runId: null }, cursor: null, ownerInstanceId: null }, frontend: { start: { outcome: 'not-submitted' } } } } })
  expect(report.execution!.diagnostics).not.toHaveProperty('failure') // No current bad frame was observed.
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.server.path, 'space', 'inspect', '--operation-id', f.input.operationId], objectCliEnvironment(f.root, {
    AGENTMUX_AGENT_SESSION_ID: f.owner.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.owner.credentials.capability
  }))
  expect(cli.code, cli.stderr).toBe(1) // Original creation remains unknown; read succeeded.
  const body = JSON.parse(cli.stdout); expect(body.ok).toBe(true)
  expect(body.result.request.report.execution).toEqual(report.execution)
  expect(cli.stdout).not.toContain('PRIVATE_FIRST_INPUT'); expect(cli.stdout).not.toContain('PRIVATE_SOURCE_NOTE'); expect(cli.stdout).not.toContain(f.owner.capability)
  await expect(f.rpc.call('agent.execution.binding', { bindingId: f.original.execution!.reference.bindingId }, { credentials: f.owner.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: { ...f.owner.credentials, capability: 'wrong-capability' } })).rejects.toThrow()
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
})
it('Source diagnostics survive owner replacement without inventing a historical protocol failure or advancing the original intent', async () => {
  const f = await fixture(); await f.restartBindings()
  const value = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: f.owner.credentials })
  expect(value.request!.report!.execution!.diagnostics).toMatchObject({ state: 'matched', reference: f.original.execution!.reference })
  expect(value.request!.report!.execution!.diagnostics).not.toHaveProperty('failure')
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
})
it('the actual Source codec rejects foreign operation/Runtime and additional private data in safe metadata', async () => {
  const f = await fixture(), params = { target: { operationId: f.input.operationId } }
  const result = await f.rpc.call('space.inspect', params, { credentials: f.owner.credentials })
  for (const change of [
    (d: AgentExecutionSourceDiagnostics) => { d.sourceRuntimeId = 'other-runtime' }, (d: AgentExecutionSourceDiagnostics) => { d.reference.createOperationId = 'other-operation' },
    (d: AgentExecutionSourceDiagnostics) => { d.reference.agentSessionId = 'other-session' }, (d: AgentExecutionSourceDiagnostics) => { Reflect.set(d, 'prompt', 'PRIVATE') },
    (d: AgentExecutionSourceDiagnostics) => { Reflect.set(d.helpers.executor, 'rawOutput', 'PRIVATE') }, (d: AgentExecutionSourceDiagnostics) => { d.helpers.executor.cursor = -1 }
  ]) { const value = structuredClone(result); change(value.request!.report!.execution!.diagnostics!); expect(() => parseRpcControlResult('space.inspect', value, params)).toThrow() }
})
it('the Source owner refuses a changed persisted placement before reading another journal', async () => {
  const f = await fixture(), path = join(f.root, 'spatial.json'), document = JSON.parse(await readFile(path, 'utf8'))
  const record = document.graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE].requests[f.input.operationId]
  record.placement!.runtimeId = 'another-source-runtime'; await writeFile(path, JSON.stringify(document))
  await expect(f.runtime.executionBindings.sourceDiagnostics!(f.input.operationId)).rejects.toMatchObject({ code: 'EXECUTION_DIAGNOSTIC_SCOPE_UNCONFIRMED' })
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled()
})

it('all Source read return branches fence revocation and a changed original Runtime', async () => {
  const f = await fixture(), originalRead = f.spatial.read.bind(f.spatial)
  let revoked = false
  const assertCurrent = async () => { if (revoked) throw Object.assign(new Error('Revoked reader'), { code: 'CONTROL_PERMISSION_DENIED' }) }
  vi.spyOn(f.spatial, 'read').mockImplementationOnce(async () => { revoked = true; return null })
  let failure: unknown
  try { await f.runtime.executionBindings.sourceDiagnostics!(f.input.operationId, { assertCurrent }) } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  vi.spyOn(f.spatial, 'read').mockImplementationOnce(async () => { const result = await originalRead(); f.runtime.ownerIdentity().runtimeId = 'replacement-source'; return result })
  await expect(f.runtime.executionBindings.sourceDiagnostics!(f.input.operationId)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
})

it('the Source-owned tuple rejects a foreign witness before any safe journal projection', async () => {
  const f = await fixture(), reference = f.original.execution!.reference
  const original = (await f.bindings.inspect(reference.bindingId, 'association'))! as AgentExecutionInspection
  for (const change of [
    (value: typeof original) => { value.agentSessionId = 'another-session' },
    (value: typeof original) => { value.agentHostId = 'another-host' },
    (value: typeof original) => { value.resourceWorkspacePath = '/another/project' },
    (value: typeof original) => { value.association = { state: 'unconfirmed', reference, issue: { code: 'EXECUTION_RUNTIME_WITNESS_UNCONFIRMED', message: 'Original witness unconfirmed' } } },
    (value: typeof original) => { if (value.association?.state === 'confirmed') value.association.reference.createOperationId = 'another-operation' },
    (value: typeof original) => { if (value.association?.state === 'confirmed') value.association.agentRuntimeId = 'another-runtime' }
  ]) {
    const witness = structuredClone(original); change(witness)
    const journal = vi.fn(async () => null)
    const result = await inspectSourceExecutionDiagnostics({ source: { spatial: f.spatial, runtimeId: () => 'runtime-b' }, operationId: f.input.operationId,
      context: {}, inspect: async () => witness, journal })
    expect(result?.state).toBe('unconfirmed'); expect(journal).not.toHaveBeenCalled()
  }
})

it('an original journal without the newer request digest still exposes only scope metadata and grants no managed control', async () => {
  const f = await fixture(true)
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: f.owner.credentials })
  expect(result.request!.report!.execution!.diagnostics).toMatchObject({ state: 'matched', reference: f.original.execution!.reference })
  expect(result.request!.report!.execution!.inspection).toBeNull()
  await expect(f.rpc.call('agent.execution.binding', { bindingId: f.original.execution!.reference.bindingId }, { credentials: f.owner.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.rpc.call('agent.execution.continue', f.original.execution!.reference, { credentials: f.owner.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
})

it('the actual authenticated Source RPC rechecks caller authority after its original read', async () => {
  const f = await fixture(), read = f.spatial.read.bind(f.spatial), authorize = f.owner.client.authorizeRetainedAgentCaller.bind(f.owner.client)
  let revoked = false, failure: unknown
  vi.spyOn(f.owner.client, 'authorizeRetainedAgentCaller').mockImplementation(async (...args) => {
    if (revoked) throw new AgentMuxError('Original caller revoked', 'AGENT_CAPABILITY_INVALID')
    return await authorize(...args)
  })
  vi.spyOn(f.spatial, 'read').mockImplementationOnce(async () => { const result = await read(); revoked = true; return result })
  try { await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: f.owner.credentials }) } catch (error) { failure = error }
  expect(failure).toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
})

it('the real original Source CLI carries both confirmed helper Starts and safe attach-frame failure from its sole Core coordinator', async () => {
  const owner = await rpcOwnerFixture(['managed-observer']); releases.push(owner.close)
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_CONTEXT', { realBindings: true, coreClients: owner.coreClients,
    helperOutput: { frontend: '{"type":"ready"}\n', executor: '[1234/PRIVATE_NATIVE_STDERR]\n' } })
  const initial = await f.rpc.call('agent.open', f.input)
  expect(initial.agent).toBeNull()
  expect(initial.issues, JSON.stringify(initial.issues)).toContainEqual(expect.objectContaining({ step: 'creation', executionFailure: expect.objectContaining({ role: 'executor', stage: 'attach' }) }))
  expect(initial.execution!.diagnostics).toMatchObject({ state: 'matched', helpers: {
    frontend: { start: { outcome: 'confirmed', runId: 'frontend-original-helper' } }, executor: { start: { outcome: 'confirmed', runId: 'executor-original-helper' } }
  }, failure: { hostId: 'local', role: 'executor', stage: 'attach', code: 'EXECUTION_PROTOCOL_INVALID_FRAME', frame: { syntax: 'invalid-json' } } })
  f.starts.mockClear()
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.server.path, 'space', 'inspect', '--operation-id', f.input.operationId], objectCliEnvironment(f.root, {
    AGENTMUX_AGENT_SESSION_ID: owner.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: owner.credentials.capability
  }))
  const body = JSON.parse(cli.stdout); expect(body.ok, cli.stderr).toBe(true)
  expect(body.result.request.report.execution.diagnostics).toEqual(initial.execution!.diagnostics)
  expect(body.result.request.report.execution.inspection).toBeNull()
  expect(cli.stdout).not.toContain('PRIVATE_')
  expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
})
