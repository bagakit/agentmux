// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { parseAgentMuxControlRequest, type AgentMuxAgentCreationInspection } from '@agentmux/core'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { inspectTakeoverOperation } from '../src/renderer/src/lib/session-takeover'

const initial = useAppStore.getState(), kinds = ['prepared-agent-creation', 'closed-agent-creation'] as const
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
beforeEach(() => useAppStore.setState({ ...initial, loading: false, config: composerConfig, sessions: [], tabs: {}, layouts: {},
  agentNames: {}, agentComposerDrafts: {}, spatialRequests: {}, spaceZoneBindings: {}, restoredWorkbench: null, originalSpatialGraph: undefined }, true))
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })
afterAll(() => dispose?.())
function observed(kind: typeof kinds[number], agentSessionId = 'original-sid', operationId = 'original-create'): AgentMuxAgentCreationInspection {
  return { kind, agentSessionId, hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: composerConfig.workspaces[0]!.path,
    creation: { createOperationId: operationId, initialPrompt: 'unknown' },
    observation: { runtimeId: 'original-native-owner', retainedRun: { runId: 'retained-native-run' } } }
}
const newZone = () => workspaceZoneId(directoryIdentity('local', composerConfig.workspaces[0]!.path), composerConfig.workspaces[0]!.id)
const control = (value: Record<string, unknown>) => useAppStore.getState().executeControl(parseAgentMuxControlRequest({ schemaVersion: 5, ...value }) as never)

it.each(kinds)('Native import retry retains %s without treating its retained Native Run as a semantic Session', async kind => {
  const creation = vi.spyOn(api.sessions, 'creation').mockResolvedValue(observed(kind)), refresh = vi.spyOn(api.sessions, 'refresh')
  const launch = vi.spyOn(api.sessions, 'launchAgent')
  const input = { hostId: 'local', executorId: 'codex', workspacePath: composerConfig.workspaces[0]!.path, agentSessionId: 'original-sid', createOperationId: 'original-create' }
  const source = { source: { workspacePath: input.workspacePath, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } } }
  await expect(useAppStore.getState().resumeNativeSession(input, source as never, composerSession().capabilities, undefined, true)).rejects.toThrow('has no confirmed Session')
  expect(creation).toHaveBeenCalledExactlyOnceWith('local', 'original-sid'); expect(refresh).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([])
})

it.each(kinds)('reopen fallback retains %s without issuing a refresh with an invented Run', async kind => {
  const original = new Error('Original reopen ACK is unconfirmed')
  vi.spyOn(api.sessions, 'reopen').mockRejectedValue(original)
  vi.spyOn(api.sessions, 'creation').mockResolvedValue(observed(kind))
  const refresh = vi.spyOn(api.sessions, 'refresh').mockResolvedValue(composerSession('original-sid'))
  await expect(useAppStore.getState().reopenRetiredSession({ agentSessionId: 'original-sid', hostId: 'local', state: 'retired', retiredAt: 1 },
    'original-reopen', false, () => true)).rejects.toBe(original)
  expect(refresh).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toEqual([])
})

it.each(kinds)('original spatial inspection reports %s as unknown without attaching a Native-only observation', async kind => {
  vi.spyOn(api.sessions, 'resolveCreationSessionId').mockResolvedValue('original-sid')
  vi.spyOn(api.sessions, 'creation').mockResolvedValue(observed(kind))
  vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Original creation result unavailable'))
  const refresh = vi.spyOn(api.sessions, 'refresh'), attach = vi.spyOn(useAppStore.getState(), 'canonicalizeAgentLaunch')
  const request = { requestId: 'original-create', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'codex' }, destination: { zoneId: newZone() }, focus: false }
  await control(request)
  const result = await control({ requestId: 'read-original-create', operation: 'space.inspect', target: { requestId: 'original-create' } })
  expect(result).toMatchObject({ request: { report: { outcome: 'unknown', issues: expect.arrayContaining([
    expect.objectContaining({ code: 'AGENT_CREATION_UNKNOWN', message: expect.stringContaining('has no confirmed Session') })
  ]) } } })
  expect(refresh).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toEqual([])
})

it.each(kinds)('fork retains %s before any new creation and preserves the original input', async kind => {
  const session = { ...composerSession('original-sid'), capabilities: { ...composerSession().capabilities, providerFork: { current: true } } }
  useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Original current draft' } })
  vi.spyOn(api.sessions, 'creation').mockResolvedValue(observed(kind))
  const launch = vi.spyOn(api.sessions, 'launchAgent')
  const result = await control({ requestId: 'original-fork', operation: 'agent.open', content: { kind: 'fork-agent', source: {
    agentSessionId: session.id, expectedRun: session.control.run, expectedNativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } } }, destination: { zoneId: newZone() }, focus: false })
  expect(result).toMatchObject({ outcome: 'unknown', issues: expect.arrayContaining([expect.objectContaining({ code: 'AGENT_CREATION_UNKNOWN' })]) })
  expect(launch).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions).toEqual([session])
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Original current draft')
})

it.each(kinds)('Takeover naming retains %s without inventing a creation time or changing the original name', async kind => {
  vi.spyOn(api.sessions, 'creation').mockResolvedValue(observed(kind))
  const rename = vi.spyOn(useAppStore.getState(), 'renameAgent')
  const report = { requestId: 'original-create', operation: 'agent.open', outcome: 'opened', agent: { agentSessionId: 'original-sid', hostId: 'local', runId: 'prior-reported-run' }, issues: [] }
  vi.spyOn(useAppStore.getState(), 'executeControl').mockResolvedValue({ operation: 'space.inspect', request: { requestId: 'original-create', report } } as never)
  const retained = await inspectTakeoverOperation({ agentSessionId: 'old-source', hostId: 'local', label: 'Original name', diagnostic: '', origin: {} }, 'original-create')
  expect(retained).toBe(report); expect(rename).not.toHaveBeenCalled()
  expect(useAppStore.getState().nameEditFailure?.message).toContain('has no confirmed Session')
})
