import assert from 'node:assert/strict'
import { parseAgentOpenDescribe, parseAgentOpenDescription, parseAgentOpenLaunchFields } from '../../src/agent-open-contract.ts'
import { AgentMuxRpcService } from '../../src/public-rpc-service.ts'
import { createHostSpatialAgentControl } from '../../../../apps/host/src/spatial-agent-control.ts'
let namespaceReads = 0, foreign = 0, optionalReads = 0
const identity = { runtimeId: 'exact-source', ownerInstanceId: 'instance', protocolVersion: 2, processId: process.pid }
const original = { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId }
const control = createHostSpatialAgentControl({ configurationPath: '/not-read', spatial: {}, runtime: () => ({ ownerIdentity: () => identity,
  client: { readAgentInputEpoch: async () => { namespaceReads++; return 'E1' } }, executionHost: async (...args) => {
    foreign++; assert.equal(args[0], 'execution'); assert.equal(args[2].observation.source.kind, 'input-epoch-reader')
    return { runtimeId: 'target', client: { readAgentInputEpoch: async () => 'E2' }, dispose: async () => {} }
  } }) })
const user = { principal: { kind: 'user', id: 'person' } }
for (const target of [null, { hostId: 'execution', runtimeId: 'target' }]) {
  const request = parseAgentOpenDescribe({ expectedRuntimeId: 'exact-source', execution: { agentTarget: target }, executionOnly: true })
  const execution = await control.describeExecution(request.execution, user)
  const result = parseAgentOpenDescription({ source: original, contracts: { ordinaryLaunch: null, externalAssociation: null, takeover: null }, execution }, request)
  assert.equal(result.execution.inputEpoch, target ? 'E2' : 'E1')
  assert.throws(() => parseAgentOpenDescription({ ...result, execution: { ...result.execution, runtimeId: 'another' } }, request), undefined, 'wrong exact execution Runtime must refuse')
  assert.throws(() => parseAgentOpenDescription({ ...result, execution: { ...result.execution, inputEpoch: undefined } }, request), undefined, 'unknown cannot become never-restored null')
  assert.deepEqual(parseAgentOpenLaunchFields({ inputEpoch: result.execution.inputEpoch, inputRuntimeId: result.execution.runtimeId }), { inputEpoch: result.execution.inputEpoch, inputRuntimeId: result.execution.runtimeId })
}
await assert.rejects(() => control.describeExecution({ agentTarget: null }, { caller: { agentSessionId: 'managed' }, principal: user.principal }))
assert.equal(namespaceReads, 1); assert.equal(foreign, 1)
control.describe = () => { optionalReads++; throw new Error('optional description unavailable') }
const service = new AgentMuxRpcService({ coreClients: () => [], spatialAgentControl: control, hostedRuntime: () => ({ call: async (method, params) => {
  assert.equal(method, 'runtime.owner.identity'); assert.deepEqual(params, { expectedRuntimeId: 'exact-source' }); return { owner: identity }
} }) })
const read = await service.call('agent.open.describe', { expectedRuntimeId: 'exact-source', execution: { agentTarget: null } }, user)
assert.equal(read.execution.inputEpoch, 'E1'); assert.equal(read.sourceIssue.message, 'optional description unavailable')
const only = await service.call('agent.open.describe', { expectedRuntimeId: 'exact-source', execution: { agentTarget: null }, executionOnly: true }, user)
assert.equal(only.execution.inputEpoch, 'E1'); assert.equal(only.sourceIssue, undefined); assert.equal(optionalReads, 1)
assert.equal(namespaceReads, 3)
console.log('SOURCE_INPUT_CUT_PASS: pure original Source/foreign namespace consumers, wrong pin and unknown rejected, optional contracts independent, managed denial, zero Native/Start')
