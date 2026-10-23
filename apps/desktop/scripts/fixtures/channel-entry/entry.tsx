import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { groupTarget, type ConnectionDiagnosis, type ConnectionRecord, type RoomBinding } from '@agentmux/core/connections'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SettingsNavigation, type SettingsNavigationRequest } from '../../../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../../../src/renderer/src/components/settings/settings-modules'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime } from '@agentmux/client-ui/theme'
import { invalidateConnectorTarget } from '../../../src/renderer/src/lib/connector-room-intent'
import type { ConnectionHostingTarget } from '../../../src/shared/contracts'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
config.workspaces = config.workspaces.map((item, index) => ({ ...item, path: fixturePath('private/channel-entry-' + index) }))
api.config.get = async () => config
await useAppStore.getState().initialize()
const executorId = Object.keys(config.executors)[0]!, workspace = config.workspaces[0]!
const launched = (await api.sessions.launchAgent({ hostId: workspace.hostId, workspacePath: workspace.path, executorId })).session
if (launched.kind !== 'agent') throw Error('Preview requires the original Agent kind')
const session = { ...launched, label: 'Research Agent', nativeHandle: { kind: 'provider' as const, providerId: launched.providerId, sessionId: 'preview-original-native' } }
const tab = createWorkbenchTab('channel-preview-tab', { kind: 'agent', phase: 'attached', regionId: 'channel-preview-region', workspaceId: workspace.id, sessionId: session.id })
useAppStore.setState({ config, loading: false, sessions: [session], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('channel-preview-group', [tab.id]) },
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', viewModes: { [session.id]: 'terminal' }, agentComposerDrafts: { [session.id]: 'Keep this original research draft.' },
  connectorRoomIntents: {}, connectorRoomDrafts: {}, connectorServiceIntents: {}, connectorServiceObservation: {} })
mountThemeRuntime(window, config.appearance)

// Controlled typed facts only. The real IPC/SDK/binding and App route are proven by the consumer tests.
const connection: ConnectionRecord = { config: { connectionId: 'preview-discord', adapterId: 'discord', application: { domain: 'discord.com', appId: '123456789012345678' },
  label: 'Research discussion', enabled: true, credentialRef: 'preview-secure-reference' }, revision: 1,
  capabilities: { roomDiscovery: true, roomCreation: false, roomLink: true },
  observation: { authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
let bindings: RoomBinding[] = []
const hostingTarget: ConnectionHostingTarget = { hostId: 'preview-bot-host', runtimeId: 'preview-original-runtime' }
const target = { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
const headerStatus = new URLSearchParams(location.search).has('header-status')
type Scenario = 'unbound' | 'owner-failure' | 'attention'
const proof = { ready: false, omitOriginal: false, status: 'normal' as 'normal' | 'attention' | 'unavailable', scenario: 'unbound' as Scenario,
  calls: [] as string[], targets: [] as (ConnectionHostingTarget | undefined)[], errors: [] as string[],
  setScenario(value: Scenario) {
    proof.scenario = value; proof.status = value === 'attention' ? 'attention' : 'normal'
    bindings = value === 'attention' ? [0, 1].map((index): RoomBinding => ({ ...target, regionAnchor: { regionId: 'channel-preview-region' }, bindingId: 'preview-original-binding-' + index,
      revision: 1, state: 'active', connectionId: connection.config.connectionId, application: connection.config.application,
      externalConversationId: index ? '456789012345678901' : room.externalConversationId,
      scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } })) : []
    invalidateConnectorTarget(target)
  },
  setLayout(narrow: boolean) {
    const next = structuredClone(tab)
    if (narrow) {
      next.layout = splitWorkbenchRegion(next.layout, 'channel-preview-region', 'left', 'channel-neighbor-region')
      if (next.layout.root.type === 'split') next.layout.root.ratio = 0.7
      next.layout.activeRegionId = 'channel-preview-region'
      next.regions['channel-neighbor-region'] = { regionId: 'channel-neighbor-region', kind: 'launcher', workspaceId: workspace.id }
    }
    useAppStore.setState({ tabs: { [next.id]: next } })
  },
  draft: () => useAppStore.getState().agentComposerDrafts[session.id]
}
const room = { externalConversationId: '345678901234567890', name: 'research-and-engineering', state: 'active' as const, mode: 'group' as const, membershipApproval: 'unknown' as const }
api.connections.hostingTarget = async () => {
  if (headerStatus && proof.scenario === 'owner-failure') throw Error('The original bot hosting connection could not be reached. Existing groups and requests are kept. Check this Host again or open its channel settings; local Agent input remains available.')
  return structuredClone(hostingTarget)
}
api.connections.onMetadataChanged = (_listener, observation) => { observation?.('ready'); return () => {} }
api.connections.call = (async (method: string, input: any, owner?: ConnectionHostingTarget) => {
  proof.calls.push(method)
  proof.targets.push(owner ? structuredClone(owner) : undefined)
  if (owner && JSON.stringify(owner) !== JSON.stringify(hostingTarget)) throw Error('The preview cannot read a different bot hosting target')
  const subject = { kind: 'conversation', externalConversationId: input.subject?.externalConversationId ?? room.externalConversationId }
  const meta = { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application,
    entry: { subject, cacheRevision: 'preview-cache', observation: { subject, state: 'observed', freshness: 'current', profile: { name: room.name, observedAt: Date.now() }, checkedAt: Date.now() } } }
  if (method === 'connection.ls') return { connections: proof.omitOriginal ? [] : [connection] }
  if (method === 'connection.inspect') return { connection, operation: null }
  if (method === 'connection.service.get') return { enabled: true, revision: 1 }
  if (method === 'connection.binding.ls') return { bindings: structuredClone(bindings) }
  if (method === 'connection.diagnose') {
    if (proof.status === 'unavailable') throw Error('Controlled unavailable local status read')
    const binding = bindings.find(binding => binding.bindingId === input.bindingId && binding.revision === input.bindingRevision)
    const attention = proof.status === 'attention'
    return { target: input, service: { value: { enabled: true, revision: 1 }, issue: null }, groups: { issue: null, value: { nextBindingId: null, items: binding ? [{
      target: groupTarget(binding), window: {}, limit: 5,
      connection: { value: { revision: connection.revision, enabled: true, ...connection.observation }, issue: null },
      binding: { value: { state: binding.state, currentRevision: binding.revision, scope: binding.scope, activeInputGrants: 0, activeAnswerGrants: 0, activePermissionGrants: 0 }, issue: null },
      outgoing: { issue: null, value: { after: null, afterContent: null, next: null,
        observation: attention ? { state: 'unavailable', reason: 'content-unconfirmed' } : { state: 'ready' },
        sourceObservation: { state: 'ready', code: null, codeRecorded: false, checkpointKey: null },
        effectObservation: attention ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'ready' },
        deliveries: attention ? [1, 2].map(i => ({ kind: 'conversation' as const, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null }, operationId: 'preview-original-' + i, state: 'unknown' as const, receipt: 'unknown' as const, platformMessageId: null, reason: 'effect-unconfirmed' as const, resourceUpload: null })) : [],
        coverage: { state: attention ? 'incomplete' : 'complete', nextContent: null, originCount: 0, omittedGapCount: 0, gaps: attention ? [1, 2, 3].map(i => ({ gapKey: 'preview-gap-' + i, reason: 'source-gap' as const, code: null, codeRecorded: false, sourceKind: null, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null } })) : [] }
      } }, incoming: { issue: null, value: { beforeIngressId: null, next: null, rows: [] } }
    }] : [] } } } satisfies ConnectionDiagnosis
  }
  if (method === 'connection.binding.inspect') { const binding = bindings.find(item => item.bindingId === input.bindingId) ?? null; return { binding, current: binding, operation: null, grants: [] } }
  if (method === 'connection.room.ls' || method === 'connection.room.search') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, observation: { state: 'ready' }, rooms: [room], next: null }
  if (method === 'connection.room.get') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, observation: { state: 'ready' }, room }
  if (method === 'connection.room.members') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, observation: { state: 'unknown', reason: 'response-unconfirmed' }, members: [], next: null }
  if (method === 'connection.metadata.get') return meta
  if (method === 'connection.metadata.ls') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, entries: [], next: null }
  if (method === 'connection.bind') {
    bindings = [{ ...input, revision: 1, state: 'active', application: connection.config.application, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } }]
    return { operationId: input.operationId, action: 'bind', state: 'applied', binding: bindings[0] }
  }
  throw Error('This preview does not execute ' + method)
}) as typeof api.connections.call
Object.assign(window, { channelEntryProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message))
window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
function Fixture() {
  const [route, setRoute] = useState<SettingsNavigationRequest | null>(null)
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={{
    open: section => setRoute({ section }), openToolkit() {}, openHost() {}, chooseAgent() {}, openMoteLark() {},
    channelPresentation: settingsCatalog.channelPresentation,
    channelEntries: settingsCatalog.channelEntries,
    openChannel: channelOrigin => setRoute({ section: settingsCatalog.channelPresentation(channelOrigin.connection.application, channelOrigin.connection.adapterId)?.section ?? 'overview', channelOrigin })
  }}><WorkspaceWorkbench workspaceId={workspace.id} />
    {route ? <SettingsPanel initialSection={route.section} navigationRequest={route} onClose={() => setRoute(null)} /> : null}
  </SettingsNavigation.Provider></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
