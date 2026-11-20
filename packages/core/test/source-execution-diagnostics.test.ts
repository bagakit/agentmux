import { AgentMuxError } from '@agentmux/core'
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
import { inspectSourceExecutionDiagnostics, sourceExecutionBindingId } from '../src/agent-execution-source-diagnostics.js'
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
      connection: { state: 'unconfirmed', code: 'EXECUTION_OBSERVATION_UNCONFIRMED' },
      lastCreationFailure: { hostId: 'local', role: 'executor', stage: 'prepare', code: 'EXECUTION_HELPER_UNAVAILABLE' },
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
  vi.spyOn(f.runtime, 'executionHost').mockRejectedValueOnce(new AgentMuxError('The original Agent observation timed out.', 'CONTROL_TIMEOUT'))
  const offline = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: f.owner.credentials })
  expect(offline.request?.report?.execution?.diagnostics).toEqual(report.execution?.diagnostics)
  expect(offline.request?.report?.issues).toContainEqual(expect.objectContaining({ code: 'CONTROL_TIMEOUT', step: 'observation' }))
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
})
it('Source diagnostics survive owner replacement without inventing a historical protocol failure or advancing the original intent', async () => {
  const f = await fixture(); await f.restartBindings()
  const value = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: f.owner.credentials })
  expect(value.request!.report!.execution!.diagnostics).toMatchObject({ state: 'matched', reference: f.original.execution!.reference,
    lastCreationFailure: { role: 'executor', stage: 'prepare', code: 'EXECUTION_HELPER_UNAVAILABLE' },
    connection: { state: 'unconfirmed', code: 'EXECUTION_OBSERVATION_UNCONFIRMED' } })
  expect(value.request!.report!.execution!.diagnostics).not.toHaveProperty('failure')
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
})
it('the actual Source codec rejects foreign operation/Runtime and additional private data in safe metadata', async () => {
  const f = await fixture(), params = { target: { operationId: f.input.operationId } }
  const result = await f.rpc.call('space.inspect', params, { credentials: f.owner.credentials })
  for (const change of [
    (d: AgentExecutionSourceDiagnostics) => { d.sourceRuntimeId = 'other-runtime' }, (d: AgentExecutionSourceDiagnostics) => { d.reference.createOperationId = 'other-operation' },
    (d: AgentExecutionSourceDiagnostics) => { d.reference.agentSessionId = 'other-session' }, (d: AgentExecutionSourceDiagnostics) => { Reflect.set(d, 'prompt', 'PRIVATE') },
    (d: AgentExecutionSourceDiagnostics) => { Reflect.set(d.helpers.executor, 'rawOutput', 'PRIVATE') }, (d: AgentExecutionSourceDiagnostics) => { d.helpers.executor.cursor = -1 },
    (d: AgentExecutionSourceDiagnostics) => { Reflect.set(d.lastCreationFailure!, 'message', 'PRIVATE') },
    (d: AgentExecutionSourceDiagnostics) => { Reflect.set(d.connection!, 'state', 'connected') },
    (d: AgentExecutionSourceDiagnostics) => { Reflect.set(d, 'notices', [{ role: 'frontend', capability: 'hooks', state: 'unverified', message: 'PRIVATE' }]) },
    (d: AgentExecutionSourceDiagnostics) => { d.state = 'unconfirmed' }
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

it('Source CLI and RPC read the original Coordinator admission after a lost ACK and disconnected Agent Host', async () => {
  const owner = await rpcOwnerFixture(['managed-observer']); releases.push(owner.close)
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_CONTEXT', { realBindings: true, coreClients: owner.coreClients })
  const admit = f.bindings.admit.getMockImplementation()!
  let reference: Awaited<ReturnType<typeof admit>> | undefined
  f.bindings.admit.mockImplementationOnce(async (...args) => {
    reference = await admit(...args)
    throw new AgentMuxError('Original Coordinator reply disconnected after durability.', 'CONTROL_CONNECTION_FAILED')
  })
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
  expect(reference).toBeDefined()
  const readGraph = () => readFile(join(f.root, 'spatial.json'), 'utf8')
  const originalGraph = await readGraph()
  expect(spatialOperation(originalGraph, f.input.operationId)).toBeUndefined()
  await f.restartBindings()
  const resolveHost = vi.spyOn(f.runtime, 'executionHost').mockRejectedValue(new Error('The Agent Host is now offline.'))
  resolveHost.mockClear()
  const params = { target: { operationId: f.input.operationId } }
  const unverified = await f.control({ operation: 'space.inspect', target: { requestId: f.input.operationId } } as never, {})
  expect(unverified).toMatchObject({ request: { known: false, report: null } })
  const result = await f.rpc.call('space.inspect', params, { credentials: owner.credentials })
  expect(result.request).toMatchObject({ known: true, report: { outcome: 'unknown', to: null, agent: null,
    execution: { coordinatorRuntimeId: 'runtime-b', reference, inspection: null, placement: 'unconfirmed',
      diagnostics: { state: 'matched', connection: { state: 'unconfirmed', code: 'EXECUTION_OBSERVATION_UNCONFIRMED' } } },
    save: { layoutApplied: false, diskDurability: 'unconfirmed' } } })
  const foreign = structuredClone(result)
  foreign.request!.report!.execution!.inspection = { bindingId: reference!.bindingId } as AgentExecutionInspection
  expect(() => parseRpcControlResult('space.inspect', foreign, params)).toThrow()
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.server.path, 'space', 'inspect', '--operation-id', f.input.operationId], objectCliEnvironment(f.root, {
    AGENTMUX_AGENT_SESSION_ID: owner.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: owner.credentials.capability
  }))
  expect(JSON.parse(cli.stdout).result.request).toEqual(result.request)
  expect(cli.stdout).not.toContain('PRIVATE_')
  expect(await readGraph()).toBe(originalGraph)
  expect(resolveHost).not.toHaveBeenCalled()
  expect(f.prepare).not.toHaveBeenCalled(); expect(f.starts).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
  f.runtime.ownerIdentity().runtimeId = 'replacement-source'
  expect(await f.runtime.executionBindings.sourceDiagnostics!(f.input.operationId)).toBeNull()
})

it('an in-process Source admission refuses a nominal binding without the original identity', async () => {
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_CONTEXT', { realBindings: true })
  const admit = f.bindings.admit.getMockImplementation()!
  f.bindings.admit.mockImplementationOnce(async (input, ...rest) =>
    await admit({ ...input, bindingId: 'arbitrary-binding', resourceGrant: { scope: 'host-user', bindingId: 'arbitrary-binding' } }, ...rest))
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'EXECUTION_INTENT_UNCONFIRMED' })
  expect((await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })).request).toMatchObject({ known: false, report: null })
  expect(f.starts).not.toHaveBeenCalled()
})

it('a matching public Admit cannot attest an unplaced Source operation', async () => {
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_CONTEXT', { realBindings: true })
  f.bindings.admit.mockImplementationOnce(async input => {
    const admit = await f.rpc.call('agent.execution.admit', input)
    expect(admit).toMatchObject({ bindingId: input.bindingId, createOperationId: f.input.operationId })
    await expect(f.rpc.call('agent.execution.admit', { ...input, sourceAdmissionRuntimeId: input.resourceRuntimeId } as never))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    throw new AgentMuxError('Fixture loss.', 'CONTROL_CONNECTION_FAILED')
  })
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
  expect((await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })).request).toMatchObject({ known: false, report: null })
  expect(f.starts).not.toHaveBeenCalled()
})

it('unavailable Coordinator reads keep operation observation unknown without blocking other Source reads', async () => {
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_CONTEXT', { realBindings: true })
  f.bindings.sourceDiagnostics.mockRejectedValueOnce(new AgentMuxError('PRIVATE storage failure', 'EXECUTION_OWNER_UNAVAILABLE'))
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })
  expect(result.request).toMatchObject({ known: false, report: null, observationIssue: { code: 'EXECUTION_DIAGNOSTIC_UNAVAILABLE' } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
  expect((await f.rpc.call('space.inspect', { target: { zoneId: f.folder.zoneId } })).catalog.zones).not.toHaveLength(0)
  expect(f.starts).not.toHaveBeenCalled()
})

it('the original Source does not choose a binding when more than one intent matches the creation operation', async () => {
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_CONTEXT', { realBindings: true })
  const admit = f.bindings.admit.getMockImplementation()!
  f.bindings.admit.mockImplementationOnce(async (input, ...rest) => {
    await admit(input, ...rest)
    const agentHostId = 'another-configured-host'
    const bindingId = sourceExecutionBindingId(input.resourceRuntimeId, agentHostId, input.agent.agentSessionId, input.agent.createOperationId)
    await admit({ ...input, agentHostId, bindingId, resourceGrant: { scope: 'host-user', bindingId } }, ...rest)
    throw new AgentMuxError('Fixture loss.', 'CONTROL_CONNECTION_FAILED')
  })
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })
  expect(result.request).toMatchObject({ known: false, report: null, observationIssue: { code: 'EXECUTION_DIAGNOSTIC_SCOPE_UNCONFIRMED' } })
  expect(f.starts).not.toHaveBeenCalled()
})

it('Source inspection returns the verified Agent receipt without settling the original Region on disk', async () => {
  const owner = await rpcOwnerFixture(['managed-observer']); releases.push(owner.close)
  const f = await sourceCreationFixture(releases, 'PRIVATE_SOURCE_CONTEXT', { coreClients: owner.coreClients })
  f.pending()
  const initial = await f.rpc.call('agent.open', f.input)
  expect(initial.agent).toBeNull()
  await f.bindings.continueOriginal(initial.execution!.reference)
  const originalGraph = await readFile(join(f.root, 'spatial.json'), 'utf8')
  expect(JSON.parse(originalGraph).graph.regions.find((region: { regionId: string }) => region.regionId === initial.to?.regionId)?.runId).toBeNull()
  const read = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } }, { credentials: owner.credentials })
  expect(read.request!.report).toMatchObject({ agent: { runId: 'original-d-run' }, to: initial.to,
    execution: { placement: 'retained' }, save: { layoutApplied: true, diskDurability: 'unconfirmed' } })
  expect(await readFile(join(f.root, 'spatial.json'), 'utf8')).toBe(originalGraph)
  expect(f.create).toHaveBeenCalledOnce(); expect(f.agentInput).not.toHaveBeenCalled()
})

function spatialOperation(document: string, operationId: string) {
  return JSON.parse(document).graph.resources[AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE]?.requests?.[operationId]
}
