import { test, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentExecutionCoordinator, type AgentExecutionHostPort, type AgentExecutionOpenInput } from '../src/agent-execution-coordinator.js'
import { parseAgentExecutionCreate, parseAgentExecutionInspection } from '../src/public-rpc-agent-execution.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { executionRouteScope } from '../src/host-route-execution.js'
import { parseHostRouteOperation } from '../src/host-route.js'
import type { AdoptedHostRoute } from '../src/host-route.js'

const identity = (runtimeId: string) => ({ runtimeId, publicKey: runtimeId + '-public-key', fingerprint: runtimeId + '-fingerprint' })
const route: AdoptedHostRoute = { source: identity('B'), hops: [{ edgeId: 'C', target: identity('C') }, { edgeId: 'D', target: identity('D') }] }
const input = (): AgentExecutionOpenInput => ({ bindingId: 'original-binding', agentHostId: 'D-over-C', agentRuntimeId: 'D', agentRoute: structuredClone(route), resourceHostId: 'local', resourceRuntimeId: 'B', resourceWorkspacePath: '/original/B/project', resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-SID', createOperationId: 'original-CID', executorId: 'original-executor', executorRevision: 'original-revision', workspacePath: '/original/D/agent' } })

test('public execution DTO preserves semantic chain pins and refuses another final Runtime or credential fields', () => {
  const original = input()
  expect(parseAgentExecutionCreate(original)).toEqual(original)
  expect(() => parseAgentExecutionCreate({ ...original, agentRuntimeId: 'another-D' })).toThrow()
  expect(() => parseAgentExecutionCreate({ ...original, agentRoute: { ...route, credential: 'not-a-route-identity' } })).toThrow()
})

test('the real Coordinator retains its adopted chain across reopen and never uses an unconfirmed direct replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-route-intent-'))
  let confirmed = true, starts = 0, creations = 0
  const resolutions: Array<{ hostId: string; route: AdoptedHostRoute | undefined }> = []
  const port = (role: 'frontend' | 'executor'): AgentExecutionHostPort => ({
    runtimeIdentity: () => ({ instanceId: role + '-original-native' }),
    listHostExecutors: async () => ({ executors: [{ executorId: 'original-executor', providerId: 'fixture', configRevision: 'original-revision' }] }),
    readAgentSession: async () => null,
    prepareAgentExecutionHelper: async () => ({ prepared: {} }),
    inspectPreparedTerminal: async () => null,
    createPreparedTerminal: async () => { starts++; return { runId: role + '-original-run', state: 'running' } },
    onRunEvent: () => () => {},
    attachTerminal: async () => ({ run: { runId: role + '-original-run', state: 'running' }, gap: null, replay: [] }),
    releaseRunAttachment: async () => {},
    readRunReplay: async () => { throw Error('No pending Input exists') },
    writeTerminal: async () => { throw Error('This reader did not admit an Input') },
    createHostAgentWithDelivery: async () => { creations++; return { session: { agentSessionId: 'original-SID', run: { runId: 'original-agent-run' } } } },
  } as unknown as AgentExecutionHostPort)
  const agent = port('frontend'), resource = port('executor')
  const options = { resolveHost: async (hostId: string, adoptedRoute?: AdoptedHostRoute) => {
    resolutions.push({ hostId, route: structuredClone(adoptedRoute) })
    return hostId === 'local' ? { runtimeId: 'B', client: resource } : { runtimeId: 'D', client: agent, ...(confirmed ? { adoptedRoute: structuredClone(route) } : {}) }
  } }
  let owner = await AgentExecutionCoordinator.open(directory, options)
  try {
    const created = await owner.create(input())
    expect(created.execution.agentRoute).toEqual(route)
    expect(resolutions.find(value => value.hostId === 'D-over-C')?.route).toEqual(route)
    const original = owner.inspect('original-binding')!
    expect(parseAgentExecutionInspection(original, { bindingId: 'original-binding', agentRoute: route })).toEqual(original)
    const db = new DatabaseSync(join(directory, 'bindings.sqlite'), { readOnly: true })
    try {
      const stored = JSON.parse(String(db.prepare('SELECT input FROM binding_intents WHERE id=?').get('original-binding')!.input))
      expect(stored).toEqual({ schema: 'agentmux.routed-execution-intent.v1', input: input() })
      expect(stored.bindingId).toBeUndefined()
    } finally { db.close() }
    await owner.dispose()
    owner = await AgentExecutionCoordinator.open(directory, options)
    confirmed = false
    await expect(owner.rejoin('original-binding')).rejects.toMatchObject({ code: 'EXECUTION_ROUTE_UNCONFIRMED' })
    const retained = owner.inspect('original-binding')!
    expect(retained.agentRoute).toEqual(route)
    expect(retained.continuation).toEqual(original.continuation)
    expect(retained.helperStarts).toEqual(original.helperStarts)
    expect(starts).toBe(2)
    expect(creations).toBe(1)
  } finally { await owner.dispose(); await rm(directory, { recursive: true, force: true }) }
})


test('the ordinary Agent open CLI retains its exact adopted chain into the original Control parser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-cli-route-'))
  try {
    const file = join(root, 'original-route.json'); await writeFile(file, JSON.stringify(route))
    const target = ['agent', 'open', '--executor', 'selected', '--agent-host', 'D-over-C', '--agent-runtime', 'D', '--agent-route', file, '--space', 'B-space', '--zone', 'B-zone', '--new-tab', '--operation-id', 'original-CID']
    const invocation = await parseAgentMuxCliInvocation(target)
    const request = rpcControlRequest('agent.open', invocation.params)
    expect(request).toMatchObject({ operation: 'agent.open', requestId: 'original-CID', content: {
      kind: 'new-agent', agentTarget: { hostId: 'D-over-C', runtimeId: 'D', adoptedRoute: route }
    } })
    await expect(parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'selected', '--agent-route', file, '--zone', 'B-zone', '--new-tab'])).rejects.toThrow('--agent-route requires')
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('route bookkeeping preserves the original business schema strings without adding a path byte cap', () => {
  const original = input()
  original.resourceWorkspacePath = '/original/' + 'directory'.repeat(1024)
  expect(parseAgentExecutionCreate(original)).toEqual(original)
  const scope = executionRouteScope(original)
  expect(parseHostRouteOperation(scope)).toEqual(scope)
})
