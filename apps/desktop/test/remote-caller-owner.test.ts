import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
/// <reference path="../../../packages/core/test/agent-creation-operation-identity.raw.d.ts" />
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { hostAgentCreationIntent, type AgentMuxHostAgentCreateInput } from '../../../packages/core/src/client.js'
import runtimeControllerSource from '../src/main/runtime-controller.ts?raw'

// Execute the production methods together, without importing Electron or replacing their routing.
const file = ts.createSourceFile('runtime-controller.ts', runtimeControllerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const declaration = file.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RuntimeController') as ts.ClassDeclaration
const methods = ['authorizedCallerHost', 'assertObservationHostConnection', 'launchAdmittedAgent']
const members = methods.map(name => {
  const member = declaration.members.find(node => node.name?.getText(file) === name)
  if (!member) throw new Error('Missing actual production method: ' + name)
  return member.getText(file)
})
const owner = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runtimeOwner')!
const compiled = ts.transpileModule(`${owner.getText(file)}\nclass ActualController { ${members.join('\n')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
})
const ActualController = new Function('AgentMuxError', 'profileAgentContext', 'hostAgentCreationIntent', 'randomUUID',
  compiled.outputText + '\nreturn ActualController;')(AgentMuxError, () => '', hostAgentCreationIntent, () => 'unexpected-operation')

const caller = { agentSessionId: 'source-session', capability: 'private-source-capability' }
function host(id: string, ids: string[] = [], kind = 'ssh') {
  return { config: { id, kind }, client: {
    runtimeOwnerIdentity: () => ({ runtimeId: id + '-runtime', availability: 'connected' }),
    agentSessions: () => ids.map(agentSessionId => ({ agentSessionId })),
    readAgentSessions: vi.fn(async () => ids.map(agentSessionId => ({ agentSessionId, hostId: 'local' }))),
    authorizeAgentCaller: vi.fn(async (capability: string, agentSessionId: string) => {
      if (!ids.includes(agentSessionId) || capability !== caller.capability) throw new AgentMuxError('Not this owner.', 'AGENT_CAPABILITY_INVALID')
      return { agentSessionId, run: { runId: 'source-run' } }
    }),
    attestAgentCreation: vi.fn(async (input: { caller: typeof caller; target: { runtimeId: string; intentDigest: string } }) => ({
      schema: 'agentmux.agent-creation-admission.v1', source: { runtimeId: 'source-runtime', agentSessionId: caller.agentSessionId, runId: 'source-run' },
      target: input.target, signature: 's'.repeat(86)
    })),
    listHostExecutors: vi.fn(async () => ({ runtimeId: id + '-runtime', executors: [{ executorId: 'remote-executor', providerId: 'claude', configRevision: 'revision' }] })),
    createHostAgentWithDelivery: vi.fn(async (_input: AgentMuxHostAgentCreateInput) => ({ session: { agentSessionId: 'new-session', run: { runId: 'new-run' } }, creation: { createOperationId: 'original-operation' } })),
    sessionTimeline: vi.fn(async () => { throw new Error('Projection unavailable') })
  } }
}
function controller(hosts: ReturnType<typeof host>[]) {
  const value = new ActualController()
  value.hosts = new Map(hosts.map(host => [host.config.id, host]))
  value.connectEndpointInBackground = vi.fn()
  value.trackHostLifecycleOperation = (_: string, action: () => unknown) => action()
  value.connectedClient = async (id: string) => value.hosts.get(id).client
  value.sessionByTarget = async () => { throw new Error('Projection unavailable') }
  return value
}

describe('Main authenticates only the original caller owner', () => {
  it('does not send a source capability to a target placed first, including the actual remote launch consumer', async () => {
    const target = host('target'), source = host('source', [caller.agentSessionId], 'local'), unrelated = host('unrelated')
    const value = controller([target, source, unrelated])
    const result = await value.launchAdmittedAgent({ hostId: 'target', executorId: 'remote-executor', workspacePath: _hygiene_fixturePath("remote/work"),
      agentSessionId: 'new-session', createOperationId: 'original-operation', prompt: 'original body',
      initialMessage: { callerAgentSessionId: caller.agentSessionId, capability: caller.capability } }, { hosts: [target.config, source.config], profile: {} })
    expect(result.created).toMatchObject({ agentSessionId: 'new-session', hostId: 'target', run: { runId: 'new-run' } })
    expect(source.client.authorizeAgentCaller).toHaveBeenCalledExactlyOnceWith(caller.capability, caller.agentSessionId)
    expect(target.client.authorizeAgentCaller).not.toHaveBeenCalled()
    expect(unrelated.client.authorizeAgentCaller).not.toHaveBeenCalled()
    expect(source.client.attestAgentCreation).toHaveBeenCalledWith(expect.objectContaining({ caller }))
    expect(target.client.createHostAgentWithDelivery).toHaveBeenCalledWith(expect.objectContaining({
      createOperationId: 'original-operation', workspacePath: _hygiene_fixturePath("remote/work"), prompt: 'original body',
      initialMessageAdmission: expect.objectContaining({ source: { runtimeId: 'source-runtime', agentSessionId: caller.agentSessionId, runId: 'source-run' } })
    }))
    const sent = target.client.createHostAgentWithDelivery.mock.calls[0]![0] as any
    expect(sent).not.toHaveProperty('initialMessage')
    expect(JSON.stringify(sent)).not.toContain(caller.capability)
    expect(source.client.attestAgentCreation.mock.calls[0]![0]).toMatchObject({ target: { runtimeId: 'target-runtime' } })
  })

  it('rejects two confirmed owners before handing either the capability', async () => {
    const first = host('first', [caller.agentSessionId]), second = host('second', [caller.agentSessionId])
    await expect(controller([first, second]).authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
    expect(first.client.authorizeAgentCaller).not.toHaveBeenCalled(); expect(second.client.authorizeAgentCaller).not.toHaveBeenCalled()
  })

  it('discovers an uncached owner from nonsecret durable facts and never treats a prefix as the caller', async () => {
    const target = host('target'), source = host('source', [caller.agentSessionId])
    source.client.agentSessions = () => []
    const value = controller([target, source])
    expect(await value.authorizedCallerHost(caller)).toBe(source)
    expect(target.client.authorizeAgentCaller).not.toHaveBeenCalled()
    source.client.authorizeAgentCaller.mockClear()
    await expect(value.authorizedCallerHost({ ...caller, agentSessionId: 'source' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    expect(source.client.authorizeAgentCaller).not.toHaveBeenCalled()
  })

  it('rejects unavailable ownership without sending credentials, and does not wait on an unrelated endpoint for a known source', async () => {
    const unavailable = host('unavailable'), source = host('source', [caller.agentSessionId], 'local')
    unavailable.client.runtimeOwnerIdentity = () => ({ runtimeId: 'unverified', availability: 'unavailable' })
    await expect(controller([unavailable]).authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(unavailable.client.authorizeAgentCaller).not.toHaveBeenCalled()
    expect(await controller([unavailable, source]).authorizedCallerHost(caller)).toBe(source)
    expect(unavailable.client.readAgentSessions).not.toHaveBeenCalled()
  })

  it('does not fall back to another Host when the selected source rejects the credential', async () => {
    const target = host('target'), source = host('source', [caller.agentSessionId], 'local')
    await expect(controller([target, source]).authorizedCallerHost({ ...caller, capability: 'forged' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
    expect(source.client.authorizeAgentCaller).toHaveBeenCalledOnce(); expect(target.client.authorizeAgentCaller).not.toHaveBeenCalled()
  })

  it('does not use a stale source hint as authority or send credentials after a same-route replacement', async () => {
    const source = host('source', [caller.agentSessionId], 'local'), value = controller([source])
    source.client.readAgentSessions.mockResolvedValueOnce([])
    await expect(value.authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    expect(source.client.authorizeAgentCaller).not.toHaveBeenCalled()
    source.client.readAgentSessions.mockImplementationOnce(async () => {
      value.hosts.set('source', host('source', [caller.agentSessionId], 'local'))
      return [{ agentSessionId: caller.agentSessionId, hostId: 'local' }]
    })
    await expect(value.authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    expect(source.client.authorizeAgentCaller).not.toHaveBeenCalled()
  })

  it('rejects unconfirmed discovery even if another endpoint has a matching Session', async () => {
    const unavailable = host('unavailable'), source = host('source', [caller.agentSessionId])
    unavailable.client.runtimeOwnerIdentity = () => ({ runtimeId: 'unverified', availability: 'unavailable' })
    source.client.agentSessions = () => []
    await expect(controller([unavailable, source]).authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(source.client.authorizeAgentCaller).not.toHaveBeenCalled()
  })

  it('does not treat another Host projection as owned durable facts', async () => {
    const source = host('source', [caller.agentSessionId])
    source.client.readAgentSessions.mockResolvedValue([{ agentSessionId: caller.agentSessionId, hostId: 'different-host' }])
    await expect(controller([source]).authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
    expect(source.client.authorizeAgentCaller).not.toHaveBeenCalled()
  })

  it('fences both same-client Runtime changes and a route replacement during authentication', async () => {
    const source = host('source', [caller.agentSessionId]), value = controller([source])
    source.client.readAgentSessions.mockImplementationOnce(async () => {
      source.client.runtimeOwnerIdentity = () => ({ runtimeId: 'replacement-runtime', availability: 'connected' })
      return [{ agentSessionId: caller.agentSessionId, hostId: 'local' }]
    })
    await expect(value.authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    expect(source.client.authorizeAgentCaller).not.toHaveBeenCalled()
    source.client.authorizeAgentCaller.mockImplementationOnce(async () => {
      value.hosts.set('source', host('source', [caller.agentSessionId]))
      return { agentSessionId: caller.agentSessionId, run: { runId: 'source-run' } }
    })
    await expect(value.authorizedCallerHost(caller)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    expect(source.client.authorizeAgentCaller).toHaveBeenCalledOnce()
    expect(source.client.attestAgentCreation).not.toHaveBeenCalled()
  })
})
