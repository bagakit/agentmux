import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { groupTarget, type ConnectionDiagnosis, type ConnectionGrant, type ConnectionRecord, type RoomBinding, type RoomBindingOperation, type RoomLinkOperation, type RoomMembersResult } from '@agentmux/core/connections'
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
const memberAccess = new URLSearchParams(location.search).has('member-access')
const connection: ConnectionRecord = { config: { connectionId: memberAccess ? 'preview-feishu' : 'preview-discord', adapterId: memberAccess ? 'feishu' : 'discord', application: memberAccess ? { domain: 'open.feishu.cn', appId: 'cli_original_members' } : { domain: 'discord.com', appId: '123456789012345678' },
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
  requests: [] as { method: string; input: unknown; owner: ConnectionHostingTarget | undefined }[],
  hostingReads: 0, routes: [] as string[], channelSections: Object.fromEntries(settingsCatalog.channelEntries.map(entry => [entry.adapterId, entry.section])),
  setScenario(value: Scenario) {
    proof.scenario = value; proof.status = value === 'attention' ? 'attention' : 'normal'
    bindings = value === 'attention' ? [0, 1].map((index): RoomBinding => ({ ...target, regionAnchor: { regionId: 'channel-preview-region' }, bindingId: 'preview-original-binding-' + index,
      revision: 1, state: 'active', connectionId: connection.config.connectionId, application: connection.config.application,
      externalConversationId: index ? '456789012345678901' : room.externalConversationId,
      scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } })) : []
    useAppStore.setState({ connectorRoomIntents: value === 'attention' ? { [joinOperation.operationId]: {
      target, hostingTarget, method: 'connection.room.link.create', input: joinOperation.input, phase: 'may-have-dispatched'
    } } : {} })
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
const room = { externalConversationId: '345678901234567890', name: 'research-and-engineering', state: 'active' as const, mode: 'group' as const, membershipApproval: 'not-required' as const }
const members: RoomMembersResult['members'] = [
  { idType: 'user_id', userId: '567890123456789012', name: 'Ava Chen' },
  { idType: 'user_id', userId: '678901234567890123', name: 'Ben Ortiz' },
  ...(memberAccess ? [{ idType: 'user_id', userId: '789012345678901234', name: 'Casey Iqbal' }] : [])
]
let memberGrants: ConnectionGrant[] = []
const memberOperations = new Map<string, RoomBindingOperation>()
const grantsFor = (binding: RoomBinding): ConnectionGrant[] => memberAccess ? structuredClone(memberGrants.filter(grant => grant.bindingId === binding.bindingId && grant.bindingRevision === binding.revision)) : binding.externalConversationId === room.externalConversationId ? [] : [{
  grantId: 'preview-original-member-grant', revision: 1, bindingId: binding.bindingId, bindingRevision: binding.revision,
  connectionId: binding.connectionId, externalConversationId: binding.externalConversationId, state: 'active', capabilities: ['input', 'answer'],
  actor: { application: binding.application, idType: members[0]!.idType, userId: members[0]!.userId }
}]
const joinOperation: RoomLinkOperation = { operationId: 'preview-original-join-link', input: { operationId: 'preview-original-join-link',
  connectionId: connection.config.connectionId, expectedConnectionRevision: connection.revision, externalConversationId: room.externalConversationId },
  application: connection.config.application, authorizedBy: { kind: 'user', id: 'preview-person' }, state: 'confirmed',
  link: { url: 'https://example.invalid/join/preview-original', expiresAtUnixSeconds: Math.floor(Date.now() / 1000) + 3600 } }
api.connections.hostingTarget = async () => {
  proof.hostingReads++
  if (headerStatus && proof.scenario === 'owner-failure') throw Error('The original bot hosting connection could not be reached. Existing groups and requests are kept. Check this Host again or open its channel settings; local Agent input remains available.')
  return structuredClone(hostingTarget)
}
api.connections.onMetadataChanged = (_listener, observation) => { observation?.('ready'); return () => {} }
api.connections.call = (async (method: string, input: any, owner?: ConnectionHostingTarget) => {
  proof.calls.push(method)
  proof.targets.push(owner ? structuredClone(owner) : undefined)
  proof.requests.push({ method, input: structuredClone(input), owner: owner ? structuredClone(owner) : undefined })
  if (owner && JSON.stringify(owner) !== JSON.stringify(hostingTarget)) throw Error('The preview cannot read a different bot hosting target')
  const subject = { kind: 'conversation', externalConversationId: input.subject?.externalConversationId ?? room.externalConversationId }
  const meta = { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application,
    entry: { subject, cacheRevision: 'preview-cache', observation: { subject, state: 'observed', freshness: 'current', profile: { name: room.name, observedAt: Date.now() }, checkedAt: Date.now() } } }
  if (method === 'connection.ls') return { connections: proof.omitOriginal ? [] : [connection] }
  if (method === 'connection.inspect') return { connection, operation: null }
  if (method === 'connection.service.get') return input.adapterId ? { adapterId: input.adapterId, enabled: true, revision: 0 } : { enabled: true, revision: 1 }
  if (method === 'connection.binding.ls') return { bindings: structuredClone(bindings) }
  if (method === 'connection.diagnose') {
    if (proof.status === 'unavailable') throw Error('Controlled unavailable local status read')
    const binding = bindings.find(binding => binding.bindingId === input.bindingId && binding.revision === input.bindingRevision)
    const attention = proof.status === 'attention', sourceGap = attention && binding?.externalConversationId === room.externalConversationId
    const unknownEffect = attention && !sourceGap
    return { target: input, service: { value: { enabled: true, revision: 1 }, issue: null }, groups: { issue: null, value: { nextBindingId: null, items: binding ? [{
      target: groupTarget(binding), window: {}, limit: 5,
      adapterService: { value: { adapterId: connection.config.adapterId, enabled: true, revision: 0 }, issue: null },
      connection: { value: { revision: connection.revision, enabled: true, ...connection.observation }, issue: null },
      binding: { value: { state: binding.state, currentRevision: binding.revision, scope: binding.scope, activeInputGrants: grantsFor(binding).length, activeAnswerGrants: grantsFor(binding).length, activePermissionGrants: 0 }, issue: null },
      outgoing: { issue: null, value: { after: null, afterContent: null, next: null,
        observation: sourceGap ? { state: 'unavailable', reason: 'content-unconfirmed' } : unknownEffect ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'ready' },
        sourceObservation: { state: 'ready', code: null, codeRecorded: false, checkpointKey: null },
        effectObservation: unknownEffect ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'ready' },
        deliveries: unknownEffect ? [1, 2].map(i => ({ kind: 'conversation' as const, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null }, operationId: 'preview-original-' + i, state: 'unknown' as const, receipt: 'unknown' as const, platformMessageId: null, reason: 'effect-unconfirmed' as const, resourceUpload: null })) : [],
        coverage: { state: sourceGap ? 'incomplete' : 'complete', nextContent: null, originCount: 0, omittedGapCount: 0, gaps: sourceGap ? [1, 2, 3].map(i => ({ gapKey: 'preview-gap-' + i, reason: 'source-gap' as const, code: null, codeRecorded: false, sourceKind: null, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null } })) : [] }
      } }, incoming: { issue: null, value: { beforeIngressId: null, next: null, rows: attention ? [{
        ingressId: 'preview-original-intake-' + binding.bindingId, sourceConnectionId: binding.connectionId, kind: 'message', state: sourceGap ? 'refused' : 'claimed',
        code: sourceGap ? 'INGRESS_ACTOR_NOT_AUTHORIZED' : null, codeRecorded: sourceGap, bindingId: binding.bindingId, bindingRevision: binding.revision,
        targetConnectionId: binding.connectionId, scope: 'current-binding', inputOperationId: sourceGap ? null : 'preview-original-agent-input',
        recording: { state: 'recorded' }, coreStatus: sourceGap ? null : 'admitted', coreObservation: sourceGap ? 'not-started' : 'observed', nativeAdoption: sourceGap ? null : 'unknown', waiting: null
      }] : [] } }
    }] : [] } } } satisfies ConnectionDiagnosis
  }
  if (method === 'connection.binding.inspect') {
    const operation = input.operationId ? memberOperations.get(input.operationId) ?? null : null
    const binding = input.operationId ? operation?.state === 'applied' ? operation.binding : null : bindings.find(item => item.bindingId === input.bindingId) ?? null
    return { binding, current: binding ? bindings.find(item => item.bindingId === binding.bindingId) ?? null : null, operation, grants: binding ? grantsFor(binding) : [] }
  }
  if (memberAccess && method === 'connection.profile.get') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application,
    language: 'en_us', state: 'observed', profile: { name: 'Research discussion' }, metadata: null, creator: { idType: members[0]!.idType, userId: members[0]!.userId },
    botId: 'preview-original-bot', onlineVersionId: null, reviewingVersionId: null, version: null }
  if (memberAccess && method === 'connection.grant') {
    const known = memberOperations.get(input.operationId)
    if (known) return structuredClone(known)
    const binding = bindings[0]!
    const grant: ConnectionGrant = { grantId: input.grantId, revision: (input.expectedRevision ?? 0) + 1, bindingId: binding.bindingId, bindingRevision: binding.revision,
      connectionId: binding.connectionId, externalConversationId: binding.externalConversationId, state: input.state, actor: structuredClone(input.actor), capabilities: input.capabilities.slice() }
    memberGrants = [...memberGrants.filter(item => item.grantId !== grant.grantId), grant]
    const operation: RoomBindingOperation = { operationId: input.operationId, action: 'grant', state: 'applied', binding: structuredClone(binding), grant: structuredClone(grant) }
    memberOperations.set(input.operationId, operation)
    return structuredClone(operation)
  }
  if (memberAccess && method === 'connection.binding.pause') {
    const previous = bindings[0]!, binding: RoomBinding = { ...previous, revision: previous.revision + 1, state: 'paused' }
    bindings = [binding]
    memberGrants = memberGrants.map(grant => ({ ...grant, revision: grant.revision + 1, bindingRevision: binding.revision }))
    const operation: RoomBindingOperation = { operationId: input.operationId, action: 'pause', state: 'applied', binding: structuredClone(binding) }
    memberOperations.set(input.operationId, operation)
    return structuredClone(operation)
  }
  if (method === 'connection.room.ls' || method === 'connection.room.search') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, observation: { state: 'ready' }, rooms: [room], next: null }
  if (method === 'connection.room.get') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, observation: { state: 'ready' }, room: { ...room, externalConversationId: input.externalConversationId } }
  if (method === 'connection.room.members') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, externalConversationId: input.externalConversationId, observation: { state: 'ready' }, members, next: null } satisfies RoomMembersResult
  if (method === 'connection.room.link.inspect') return { operation: input.operationId === joinOperation.operationId ? structuredClone(joinOperation) : null }
  if (method === 'connection.metadata.get') return meta
  if (method === 'connection.metadata.ls') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, entries: [], next: null }
  if (method === 'connection.bind') {
    bindings = [{ ...input, revision: 1, state: 'active', application: connection.config.application, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } }]
    return { operationId: input.operationId, action: 'bind', state: 'applied', binding: bindings[0] }
  }
  throw Error('This preview does not execute ' + method)
}) as typeof api.connections.call
if (memberAccess) {
  const binding: RoomBinding = { ...target, regionAnchor: { regionId: 'channel-preview-region' }, bindingId: 'preview-original-member-binding', revision: 1, state: 'active',
    connectionId: connection.config.connectionId, application: connection.config.application, externalConversationId: room.externalConversationId,
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } }
  bindings = [binding]
  memberGrants = [{ grantId: 'preview-original-ava-grant', revision: 1, bindingId: binding.bindingId, bindingRevision: 1, connectionId: binding.connectionId,
    externalConversationId: binding.externalConversationId, actor: { application: binding.application, idType: members[0]!.idType, userId: members[0]!.userId },
    state: 'active', capabilities: ['input', 'answer', 'permission'] }]
  const input = { operationId: 'preview-original-ben-pending', bindingId: binding.bindingId, expectedBindingRevision: 1, grantId: 'preview-original-ben-grant', expectedRevision: null,
    actor: { application: binding.application, idType: members[1]!.idType, userId: members[1]!.userId }, capabilities: ['input' as const], state: 'active' as const }
  memberOperations.set(input.operationId, { operationId: input.operationId, action: 'grant', state: 'preparing' })
  useAppStore.setState({ connectorRoomIntents: { [input.operationId]: { target, hostingTarget, method: 'connection.grant', input, phase: 'may-have-dispatched' } } })
  Object.assign(proof, { member: {
    refuseOriginal() { memberOperations.set(input.operationId, { operationId: input.operationId, action: 'grant', state: 'refused', code: 'ROOM_GRANT_REVISION_CONFLICT' }) },
    facts: () => ({ bindings: structuredClone(bindings), grants: structuredClone(memberGrants), operations: [...memberOperations.values()].map(item => structuredClone(item)),
      intents: structuredClone(useAppStore.getState().connectorRoomIntents), drafts: structuredClone(useAppStore.getState().connectorRoomDrafts) })
  } })
}
Object.assign(window, { channelEntryProof: proof })
window.addEventListener('error', event => proof.errors.push(event.message))
window.addEventListener('unhandledrejection', event => proof.errors.push(String(event.reason)))
function Fixture() {
  const [route, setRoute] = useState<SettingsNavigationRequest | null>(null)
  return <DesktopClientUiProvider><SettingsNavigation.Provider value={{
    open: section => { proof.routes.push(section); setRoute({ section }) }, openToolkit() {}, openHost() {}, chooseAgent() {}, openMoteLark() {},
    channelPresentation: settingsCatalog.channelPresentation,
    channelEntries: settingsCatalog.channelEntries,
    openChannel: channelOrigin => setRoute({ section: settingsCatalog.channelPresentation(channelOrigin.connection.application, channelOrigin.connection.adapterId)?.section ?? 'overview', channelOrigin })
  }}><WorkspaceWorkbench workspaceId={workspace.id} />
    {route ? <SettingsPanel initialSection={route.section} navigationRequest={route} onClose={() => setRoute(null)} /> : null}
  </SettingsNavigation.Provider></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
