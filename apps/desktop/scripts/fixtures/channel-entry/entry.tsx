import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { groupTarget, type ConnectionApplicationAccessOperation, type ConnectionApplicationGrant, type ConnectionDiagnosis, type ConnectionGrant, type ConnectionMemberAccess, type ConnectionRecord, type RoomBinding, type RoomBindingOperation, type RoomLinkOperation, type RoomMembersResult } from '@agentmux/core/connections'
import { conversationRevision, parseConversationReadPage, projectConversationTimeline, type ConversationTimelineReadInput } from '@agentmux/core/conversation'
import type { AgentTimelineSnapshot, AgentInputSubmissionReceipt } from '@agentmux/core'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { SettingsNavigation, type SettingsNavigationRequest } from '../../../src/renderer/src/components/SettingsNavigation'
import { settingsCatalog } from '../../../src/renderer/src/components/settings/settings-modules'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { conversationMessageSourceKey } from '@agentmux/client-ui/conversation-message-location'
import { invalidateConnectorTarget } from '../../../src/renderer/src/lib/connector-room-intent'
import type { ConnectionHostingTarget } from '../../../src/shared/contracts'
import { fixturePath } from '../../lib/fixture-values.mjs'
import observedGroupAvatar from '../../../src/renderer/src/assets/pmo-teams-topic-avatar.png'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
config.workspaces = config.workspaces.map((item, index) => ({ ...item, path: fixturePath('private/channel-entry-' + index) }))
api.config.get = async () => config
await useAppStore.getState().initialize()
const executorId = Object.keys(config.executors)[0]!, workspace = config.workspaces[0]!
const launched = (await api.sessions.launchAgent({ hostId: workspace.hostId, workspacePath: workspace.path, executorId })).session
if (!launched || launched.kind !== 'agent') throw Error('Preview requires the original Agent kind')
const session = { ...launched, label: 'Research Agent', nativeHandle: { kind: 'provider' as const, providerId: launched.providerId, sessionId: 'preview-original-native' } }
const tab = createWorkbenchTab('channel-preview-tab', { kind: 'agent', phase: 'attached', regionId: 'channel-preview-region', workspaceId: workspace.id, sessionId: session.id })
useAppStore.setState({ config, loading: false, sessions: [session], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('channel-preview-group', [tab.id]) },
  activeWorkspaceId: workspace.id, mainSurface: 'workbench', viewModes: { [session.id]: new URLSearchParams(location.search).has('conversation-sync') ? 'activity' : 'terminal' }, agentComposerDrafts: { [session.id]: 'Keep this original research draft.' },
  connectorRoomIntents: {}, connectorRoomDrafts: {}, connectorServiceIntents: {}, connectorServiceObservation: {} })
mountThemeRuntime(window, config.appearance)

// Controlled typed facts only. The real IPC/SDK/binding and App route are proven by the consumer tests.
const conversationSharing = new URLSearchParams(location.search).has('conversation-sharing')
const conversationSync = new URLSearchParams(location.search).has('conversation-sync')
const sharedAudiences = conversationSharing || conversationSync
let composerScenario: 'normal' | 'unavailable' | 'paused-off' = 'normal'
const composerReads: { kind: 'metadata' | 'service'; scenario: string; connectionId?: string; adapterId?: string; state: string }[] = []
const composerWrites: { method: string; args: unknown[] }[] = []
const composerConversationReads: string[] = []
const composerNames = ['Research and Engineering - customer investigation and release planning', 'Cross-platform product collaboration and operational follow-up']
const popoverClarity = new URLSearchParams(location.search).has('popover-clarity')
const refusalClarity = new URLSearchParams(location.search).has('refusal-clarity')
const questionValidation = new URLSearchParams(location.search).has('question-validation')
const groupClarity = new URLSearchParams(location.search).has('group-clarity')
const groupDetails = new URLSearchParams(location.search).has('group-details')
const connectorDetails = new URLSearchParams(location.search).has('connector-details-modern')
const entityOverview = new URLSearchParams(location.search).has('entity-overview')
const inputRecovery = new URLSearchParams(location.search).has('input-recovery')
const statusPriority = new URLSearchParams(location.search).has('status-priority')
const groupActivityActions = connectorDetails || inputRecovery || statusPriority || new URLSearchParams(location.search).has('group-activity-actions')
const memberAccess = new URLSearchParams(location.search).has('member-access')
const applicationAccess = new URLSearchParams(location.search).has('application-access'), memberScenario = memberAccess || applicationAccess
const feishuScenario = memberScenario || sharedAudiences || popoverClarity || refusalClarity || groupActivityActions
const connection: ConnectionRecord = { config: { connectionId: feishuScenario ? 'preview-feishu' : 'preview-discord', adapterId: feishuScenario ? 'feishu' : 'discord', application: feishuScenario ? { domain: 'open.feishu.cn', appId: 'cli_original_members' } : { domain: 'discord.com', appId: '123456789012345678' },
  label: sharedAudiences ? 'Lark research bot' : 'Research discussion', enabled: true, credentialRef: 'preview-secure-reference' }, revision: 1,
  capabilities: { roomDiscovery: true, roomCreation: false, roomLink: true },
  observation: { authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
const secondConnection: ConnectionRecord = { ...connection, config: { ...connection.config, connectionId: 'preview-second-discord', adapterId: 'discord', application: { domain: 'discord.com', appId: '234567890123456789' }, label: 'Discord project bot' } }
let bindings: RoomBinding[] = []
const hostingTarget: ConnectionHostingTarget = { hostId: 'preview-bot-host', runtimeId: 'preview-original-runtime' }
const target = { executionHostId: session.control.hostId, agentSessionId: session.control.agentSessionId }
const headerStatus = new URLSearchParams(location.search).has('header-status')
type Scenario = 'unbound' | 'owner-failure' | 'attention' | 'mixed' | 'unsupported' | 'healthy'
const proof = { clarityPaused: false, clarityRepliesOnly: false, clarityMulti: false, clarityNoAvatar: false, clarityJoinUnknown: false, profileStale: false, syncOff: false, ready: false, omitOriginal: false, accessUnavailable: false, status: 'normal' as 'normal' | 'attention' | 'unavailable', scenario: 'unbound' as Scenario,
  lastDiagnosis: null as ConnectionDiagnosis | null,
  calls: [] as string[], targets: [] as (ConnectionHostingTarget | undefined)[], errors: [] as string[],
  requests: [] as { method: string; input: unknown; owner: ConnectionHostingTarget | undefined }[],
  hostingReads: 0, routes: [] as string[], channelSections: Object.fromEntries(settingsCatalog.channelEntries.map(entry => [entry.adapterId, entry.section])),
  setTheme(appAppearance: 'light' | 'dark') { updateThemeSelection({ ...config.appearance, appAppearance }) },
  setScenario(value: Scenario) {
    proof.scenario = value; proof.status = value === 'attention' ? 'attention' : 'normal'
    bindings = value === 'attention' || value === 'mixed' || value === 'unsupported' || value === 'healthy' ? (proof.clarityMulti ? [0, 1] : value === 'mixed' || value === 'unsupported' || value === 'healthy' ? [0] : [0, 1]).map((index): RoomBinding => ({ ...target, regionAnchor: { regionId: 'channel-preview-region' }, bindingId: 'preview-original-binding-' + index,
      revision: 1, state: proof.clarityPaused ? 'paused' : 'active', connectionId: connection.config.connectionId, application: connection.config.application,
      externalConversationId: index ? '456789012345678901' : room.externalConversationId,
      scope: { input: 'mentions-and-replies', publication: refusalClarity || proof.clarityRepliesOnly ? 'future-native-user-facing' : 'future-shared-conversation' }, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } })) : []
    useAppStore.setState({ connectorRoomIntents: value === 'attention' || groupClarity ? { [joinOperation.operationId]: {
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
function originalWaitingReceipt(): AgentInputSubmissionReceipt {
  const key = { kind: 'message' as const, agentSessionId: target.agentSessionId, expectedRun: { runId: 'preview-original-run' }, messageId: 'preview-original-message' }, ref = { key, waitGeneration: 1 }
  return { key, ref, originalControlOperationId: 'preview-original-agent-input', persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
    control: { ref, state: 'enabled', at: 1, waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { name: 'AgentMuxError', message: 'Original input observation unavailable' } } } }
}
const room = { externalConversationId: '345678901234567890', name: 'research-and-engineering', state: 'active' as const, mode: 'group' as const, membershipApproval: 'not-required' as const }
const members: RoomMembersResult['members'] = [
  { idType: 'user_id', userId: '567890123456789012', name: 'Ava Chen' },
  { idType: 'user_id', userId: '678901234567890123', name: connectorDetails ? 'Ben Ortiz · Product Research and Cross-platform Collaboration' : 'Ben Ortiz' },
  ...(memberScenario || groupActivityActions ? [{ idType: 'user_id', userId: '789012345678901234', name: 'Casey Iqbal' }] : [])
]
let memberGrants: ConnectionGrant[] = []
const memberOperations = new Map<string, RoomBindingOperation>()
let applicationGrants: ConnectionApplicationGrant[] = []
const applicationOperations = new Map<string, ConnectionApplicationAccessOperation>()
// These are specific controlled public observations, not an authorization implementation.
const previewMemberAccess = (binding: RoomBinding): ConnectionMemberAccess[] => members.map(member => {
  const actor = { application: binding.application, idType: member.idType, userId: member.userId }
  const local = (groupActivityActions ? grantsFor(binding) : memberGrants).find(grant => grant.actor.userId === member.userId), app = applicationGrants.find(grant => grant.actor.userId === member.userId)
  return { actor, local: local ? { kind: 'override', grant: structuredClone(local) } : { kind: 'none', previousDecision: false },
    effective: local ? { actor, state: local.state, capabilities: local.capabilities, source: { kind: 'room', grantId: local.grantId, revision: local.revision } }
      : app ? { actor, state: app.state, capabilities: app.capabilities, source: { kind: 'application', grantId: app.grantId, revision: app.revision } } : null }
})
const grantsFor = (binding: RoomBinding): ConnectionGrant[] => memberScenario ? structuredClone(memberGrants.filter(grant => grant.bindingId === binding.bindingId && grant.bindingRevision === binding.revision)) : !popoverClarity && !refusalClarity && !groupActivityActions && binding.externalConversationId === room.externalConversationId ? [] : (groupActivityActions ? members.slice(0, 2) : [members[0]!]).map((member, index) => ({
  grantId: 'preview-original-member-grant-' + index, revision: 1, bindingId: binding.bindingId, bindingRevision: binding.revision,
  connectionId: binding.connectionId, externalConversationId: binding.externalConversationId, state: 'active', capabilities: groupActivityActions && !index ? ['input', 'answer', 'permission'] : ['input', 'answer'],
  actor: { application: binding.application, idType: member.idType, userId: member.userId }
}))
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
  const sourceConnection = sharedAudiences && input.connectionId === secondConnection.config.connectionId ? secondConnection : connection
  const meta = { connectionId: sourceConnection.config.connectionId, connectionRevision: 1, application: sourceConnection.config.application,
    entry: { subject, cacheRevision: 'preview-cache', observation: { subject, state: 'observed', freshness: conversationSync || proof.profileStale ? 'stale' : 'current', profile: { name: conversationSync ? composerNames[sourceConnection === secondConnection ? 1 : 0] : groupDetails && proof.scenario === 'mixed' ? 'Research and Engineering · Customer investigation and release planning' : room.name,
      ...((entityOverview || groupDetails) && !proof.clarityNoAvatar ? { avatarUrl: observedGroupAvatar } : {}), observedAt: conversationSync ? 1 : Date.now() }, checkedAt: conversationSync ? 1 : Date.now() } } }
  if (method === 'connection.ls') return { connections: proof.omitOriginal ? [] : sharedAudiences ? [connection, secondConnection] : [connection] }
  if (method === 'connection.inspect') return { connection: sourceConnection, operation: null }
  if (method === 'connection.service.get') {
    if (conversationSync) composerReads.push({ kind: 'service', scenario: composerScenario, adapterId: input.adapterId, state: !input.adapterId && composerScenario === 'unavailable' ? 'unavailable' : !input.adapterId && composerScenario === 'paused-off' ? 'off' : 'enabled' })
    if (conversationSync && composerScenario === 'unavailable' && !input.adapterId) throw Error('Controlled original global policy read unavailable')
    return input.adapterId ? { adapterId: input.adapterId, enabled: true, revision: 0 } : { enabled: !proof.syncOff && (!conversationSync || composerScenario !== 'paused-off'), revision: conversationSync && composerScenario === 'paused-off' ? 2 : 1 }
  }
  if (method === 'connection.binding.ls') return { bindings: structuredClone(bindings) }
  if (method === 'connection.diagnose') {
    if (proof.status === 'unavailable') throw Error('Controlled unavailable local status read')
    const binding = bindings.find(binding => binding.bindingId === input.bindingId && binding.revision === input.bindingRevision)
    const mixed = (popoverClarity || groupActivityActions) && proof.scenario === 'mixed'
    const unsupported = refusalClarity && proof.scenario === 'unsupported'
    const healthy = statusPriority && proof.scenario === 'healthy'
    const attention = proof.status === 'attention', sourceGap = !inputRecovery && (attention || groupActivityActions && (!statusPriority || mixed)) && binding?.externalConversationId === room.externalConversationId
    const unknownEffect = mixed && !statusPriority || attention && !sourceGap
    const effective = binding && applicationAccess ? previewMemberAccess(binding).flatMap(member => member.effective?.state === 'active' ? [member.effective] : []) : null
    const report = { target: input, service: { value: { enabled: !proof.syncOff, revision: 1 }, issue: null }, groups: { issue: null, value: { nextBindingId: null, items: binding ? [{
      target: groupTarget(binding), window: {}, limit: 5,
      adapterService: { value: { adapterId: connection.config.adapterId, enabled: true, revision: 0 }, issue: null },
      connection: { value: { revision: connection.revision, enabled: true, ...connection.observation }, issue: null },
      binding: { value: { state: binding.state, currentRevision: binding.revision, scope: binding.scope, activeInputGrants: effective ? effective.filter(grant => grant.capabilities.includes('input')).length : grantsFor(binding).length, activeAnswerGrants: effective ? effective.filter(grant => grant.capabilities.includes('answer')).length : grantsFor(binding).length, activePermissionGrants: effective ? effective.filter(grant => grant.capabilities.includes('permission')).length : grantsFor(binding).filter(grant => grant.capabilities.includes('permission')).length }, issue: null },
      outgoing: { issue: null, value: { after: null, afterContent: null, next: null,
        observation: proof.accessUnavailable ? { state: 'unavailable', reason: 'access-unconfirmed' } : sourceGap ? { state: 'unavailable', reason: 'content-unconfirmed' } : unknownEffect ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'ready' },
        sourceObservation: { state: 'ready', code: null, codeRecorded: false, checkpointKey: null },
        effectObservation: unknownEffect ? { state: 'unknown', reason: 'effect-unconfirmed' } : { state: 'ready' },
        deliveries: mixed || unsupported || healthy ? (unsupported ? [1] : [1, 2, 3, 4, 5]).map(i => ({ kind: statusPriority && i === 5 ? 'binding-notice' as const : 'conversation' as const, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null }, operationId: 'preview-recent-confirmed-' + i, state: 'confirmed' as const, receipt: 'confirmed' as const, platformMessageId: 'preview-platform-message-' + i, reason: null, resourceUpload: null })) : unknownEffect ? [1, 2].map(i => ({ kind: 'conversation' as const, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null }, operationId: 'preview-original-' + i, state: 'unknown' as const, receipt: 'unknown' as const, platformMessageId: null, reason: 'effect-unconfirmed' as const, resourceUpload: null })) : [],
        coverage: { state: sourceGap ? 'incomplete' : 'complete', nextContent: null, originCount: 0, omittedGapCount: 0, gaps: sourceGap ? (statusPriority ? [1, 2] : groupActivityActions ? [1] : [1, 2, 3]).map(i => ({ gapKey: 'preview-gap-' + i, reason: groupActivityActions ? 'public-content-unconfirmed' as const : 'source-gap' as const, code: null, codeRecorded: false, sourceKind: null, association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null } })) : [] }
      } }, incoming: { issue: null, value: { beforeIngressId: null, next: null, rows: attention || mixed || unsupported || healthy ? [{
        ingressId: 'preview-original-intake-' + binding.bindingId, sourceConnectionId: binding.connectionId, kind: (statusPriority && mixed || questionValidation) ? 'action' : 'message', state: sourceGap || unsupported ? 'refused' : 'claimed',
        code: questionValidation ? 'INGRESS_QUESTION_ANSWER_INVALID' : unsupported ? 'INGRESS_CONTENT_UNSUPPORTED' : sourceGap ? statusPriority ? 'INGRESS_ACTION_UNSUPPORTED' : 'INGRESS_ACTOR_NOT_AUTHORIZED' : null, codeRecorded: sourceGap || unsupported, bindingId: (statusPriority && mixed || questionValidation) ? null : binding.bindingId, bindingRevision: (statusPriority && mixed || questionValidation) ? null : binding.revision,
        targetConnectionId: (statusPriority && mixed || questionValidation) ? null : binding.connectionId, scope: (statusPriority && mixed || questionValidation) ? 'group-event' : 'current-binding', inputOperationId: sourceGap || unsupported ? null : 'preview-original-agent-input',
        recording: (statusPriority && mixed || questionValidation) ? null : unsupported ? { state: 'refused', code: 'INGRESS_CONTENT_UNSUPPORTED' } : { state: 'recorded' }, coreStatus: sourceGap || unsupported ? null : mixed ? 'bytes-accepted' : 'admitted', coreObservation: sourceGap || unsupported ? 'not-started' : 'observed', nativeAdoption: sourceGap || unsupported ? null : 'unknown', waiting: null
      }] : [] } }
    }] : [] } } } satisfies ConnectionDiagnosis
    if (inputRecovery && binding) {
      const recovery: ConnectionDiagnosis = report, group = recovery.groups.value!.items[0]!
      group.outgoing.value!.deliveries = (proof.scenario === 'mixed' ? ['conversation', 'query-feedback', 'query-feedback'] : ['query-feedback', 'query-feedback']).map((kind, i) => ({ kind: kind as 'conversation' | 'query-feedback', association: { sourceKey: null, recordKey: null, eventKey: null, partKey: null }, operationId: 'preview-original-feedback-' + i, state: 'confirmed', receipt: 'confirmed', platformMessageId: 'preview-platform-result-' + i, reason: null, resourceUpload: null }))
      group.outgoing.value!.observation = { state: 'ready' }; group.outgoing.value!.effectObservation = null
      group.incoming.value!.rows = [{ ingressId: 'preview-original-intake-' + binding.bindingId, sourceConnectionId: binding.connectionId, kind: 'message', state: 'claimed', code: null, codeRecorded: false, bindingId: binding.bindingId, bindingRevision: binding.revision, targetConnectionId: binding.connectionId, scope: 'current-binding', inputOperationId: 'preview-original-agent-input', recording: { state: 'recorded' }, coreStatus: 'waiting', coreObservation: 'observed', nativeAdoption: null, waiting: originalWaitingReceipt().control.waiting! }]
    }
    if (connectorDetails && binding) {
      const diagnosis: ConnectionDiagnosis = report, group = diagnosis.groups.value!.items[0]!, outgoing = group.outgoing.value!
      if (proof.scenario === 'mixed') {
        outgoing.sourceObservation = { state: 'unavailable', reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED', codeRecorded: true, checkpointKey: 'a'.repeat(64) }
        outgoing.deliveries = outgoing.deliveries.slice(0, 2)
        outgoing.deliveries[1] = { ...outgoing.deliveries[1]!, state: 'unknown', receipt: 'unknown', platformMessageId: null, reason: 'effect-unconfirmed' }
        group.incoming.value!.rows = [{ ...group.incoming.value!.rows[0]!, kind: 'message', state: 'claimed', code: null, codeRecorded: false, bindingId: binding.bindingId, bindingRevision: binding.revision, targetConnectionId: binding.connectionId, scope: 'current-binding', inputOperationId: 'preview-original-agent-input', recording: { state: 'recorded' }, coreStatus: 'waiting', coreObservation: 'observed', nativeAdoption: null, waiting: originalWaitingReceipt().control.waiting! }]
      } else {
        outgoing.observation = { state: 'ready' }; outgoing.sourceObservation = { state: 'ready', code: null, codeRecorded: false, checkpointKey: null }; outgoing.effectObservation = { state: 'ready' }
        outgoing.deliveries = []; outgoing.coverage = { state: 'complete', nextContent: null, originCount: 0, omittedGapCount: 0, gaps: [] }; group.incoming.value!.rows = []
      }
    }
    if (popoverClarity || refusalClarity || groupActivityActions) proof.lastDiagnosis = structuredClone(report)
    return report
  }
  if (inputRecovery && method === 'connection.ingress.inspect') {
    const binding = bindings.find(value => input.ingressId === 'preview-original-intake-' + value.bindingId)!
    const receipt = originalWaitingReceipt()
    return { ingress: { kind: 'message', ingressId: input.ingressId, application: binding.application, externalConversationId: binding.externalConversationId, input: { operationId: receipt.originalControlOperationId, hostId: binding.executionHostId, agentSessionId: binding.agentSessionId, expectedRun: receipt.key.expectedRun, messageId: 'preview-original-message', author: { bindingId: binding.bindingId, bindingRevision: binding.revision, connectionId: binding.connectionId } } }, inputReceipt: receipt, observation: 'observed' }
  }
  if (method === 'connection.binding.inspect') {
    const operation = input.operationId ? memberOperations.get(input.operationId) ?? null : null
    const binding = input.operationId ? operation?.state === 'applied' ? operation.binding : null : bindings.find(item => item.bindingId === input.bindingId) ?? null
    return { binding, current: binding ? bindings.find(item => item.bindingId === binding.bindingId) ?? null : null, operation, grants: binding ? grantsFor(binding) : [], ...((applicationAccess || groupActivityActions) && binding && !input.operationId && input.revision === undefined ? { access: previewMemberAccess(binding) } : {}) }
  }
  if ((memberScenario || popoverClarity || groupActivityActions) && method === 'connection.profile.get') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application,
    language: 'en_us', state: 'observed', profile: { name: 'Research discussion' }, metadata: null, creator: { idType: members[0]!.idType, userId: members[0]!.userId },
    botId: 'preview-original-bot', onlineVersionId: null, reviewingVersionId: null, version: null }
  if (applicationAccess && method === 'connection.application.access.get') return { connectionId: connection.config.connectionId, connectionRevision: 1, adapterId: connection.config.adapterId, application: connection.config.application, grants: structuredClone(applicationGrants) }
  if (applicationAccess && method === 'connection.application.access.inspect') return { operation: structuredClone(applicationOperations.get(input.operationId) ?? null) }
  if (applicationAccess && method === 'connection.application.access.configure') {
    const original = applicationOperations.get(input.operationId)
    if (original) return structuredClone(original)
    const grant: ConnectionApplicationGrant = { grantId: input.grantId, revision: (input.expectedRevision ?? 0) + 1, adapterId: connection.config.adapterId, actor: structuredClone(input.actor), state: input.state, capabilities: input.capabilities.slice() }
    applicationGrants = [...applicationGrants.filter(item => item.grantId !== grant.grantId), grant]
    const operation: ConnectionApplicationAccessOperation = { operationId: input.operationId, state: 'applied', grant }
    applicationOperations.set(input.operationId, operation)
    return structuredClone(operation)
  }
  if (applicationAccess && method === 'connection.binding.member.inherit') {
    const operation: RoomBindingOperation = { operationId: input.operationId, action: 'inherit', state: 'applied', binding: structuredClone(bindings[0]!), inherited: { actor: structuredClone(input.actor), grants: [structuredClone(input.expectedGrant)] } }
    memberGrants = memberGrants.filter(grant => grant.grantId !== input.expectedGrant.grantId)
    memberOperations.set(input.operationId, operation)
    return structuredClone(operation)
  }
  if (memberScenario && method === 'connection.grant') {
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
  if (method === 'connection.room.link.inspect') return { operation: input.operationId === joinOperation.operationId && !proof.clarityJoinUnknown ? structuredClone(joinOperation) : null }
  if (applicationAccess && method === 'connection.setup.ls') return { operations: [], next: null, support: { connectionRevision: 1, capabilities: [] } }
  if (applicationAccess && method === 'connection.profile.ls') return { operations: [], next: null }
  const actorMetadata = members.map(member => { const actor = { application: connection.config.application, idType: member.idType, userId: member.userId }; return { subject: { kind: 'actor', actor }, cacheRevision: 'preview-actor-' + member.userId, observation: { actor, state: 'observed', freshness: proof.profileStale ? 'stale' : 'current', profile: { name: member.name, observedAt: 1 }, checkedAt: 1 } } })
  if (conversationSync && method === 'connection.metadata.get') {
    composerReads.push({ kind: 'metadata', scenario: composerScenario, connectionId: sourceConnection.config.connectionId, state: composerScenario === 'unavailable' ? 'unavailable' : 'observed-stale' })
    if (composerScenario === 'unavailable') throw Error('Controlled original cached group name read unavailable')
  }
  if (method === 'connection.metadata.get') return input.subject.kind === 'actor' ? { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, entry: actorMetadata.find(entry => entry.subject.actor.userId === input.subject.actor.userId && entry.subject.actor.idType === input.subject.actor.idType)! } : meta
  if (method === 'connection.metadata.ls') return { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application, entries: applicationAccess && input.kind === 'actor' ? actorMetadata : [], next: null }
  if (method === 'connection.bind') {
    bindings = [{ ...input, revision: 1, state: 'active', application: connection.config.application, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } }]
    return { operationId: input.operationId, action: 'bind', state: 'applied', binding: bindings[0] }
  }
  throw Error('This preview does not execute ' + method)
}) as typeof api.connections.call
if (memberScenario) {
  const binding: RoomBinding = { ...target, regionAnchor: { regionId: 'channel-preview-region' }, bindingId: 'preview-original-member-binding', revision: 1, state: 'active',
    connectionId: connection.config.connectionId, application: connection.config.application, externalConversationId: room.externalConversationId,
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } }
  bindings = [binding]
  memberGrants = applicationAccess ? [] : [{ grantId: 'preview-original-ava-grant', revision: 1, bindingId: binding.bindingId, bindingRevision: 1, connectionId: binding.connectionId,
    externalConversationId: binding.externalConversationId, actor: { application: binding.application, idType: members[0]!.idType, userId: members[0]!.userId },
    state: 'active', capabilities: ['input', 'answer', 'permission'] }]
  const input = { operationId: 'preview-original-ben-pending', bindingId: binding.bindingId, expectedBindingRevision: 1, grantId: 'preview-original-ben-grant', expectedRevision: null,
    actor: { application: binding.application, idType: members[1]!.idType, userId: members[1]!.userId }, capabilities: ['input' as const], state: 'active' as const }
  if (!applicationAccess) {
    memberOperations.set(input.operationId, { operationId: input.operationId, action: 'grant', state: 'preparing' })
    useAppStore.setState({ connectorRoomIntents: { [input.operationId]: { target, hostingTarget, method: 'connection.grant', input, phase: 'may-have-dispatched' } } })
  }
  Object.assign(proof, { member: {
    refuseOriginal() { memberOperations.set(input.operationId, { operationId: input.operationId, action: 'grant', state: 'refused', code: 'ROOM_GRANT_REVISION_CONFLICT' }) },
    facts: () => ({ bindings: structuredClone(bindings), grants: structuredClone(memberGrants), operations: [...memberOperations.values()].map(item => structuredClone(item)),
      intents: structuredClone(useAppStore.getState().connectorRoomIntents), drafts: structuredClone(useAppStore.getState().connectorRoomDrafts) })
  } })
  if (applicationAccess) Object.assign(proof, { application: {
    unavailable() { proof.accessUnavailable = true; invalidateConnectorTarget(target) },
    facts: () => ({ grants: structuredClone(applicationGrants), operations: [...applicationOperations.values()].map(item => structuredClone(item)), memberGrants: structuredClone(memberGrants), drafts: structuredClone(useAppStore.getState().manualConnectionIntents), groupDrafts: structuredClone(useAppStore.getState().connectorRoomDrafts) })
  } })
}
if (sharedAudiences) {
  bindings = [{ ...target, regionAnchor: { regionId: 'channel-preview-region' }, bindingId: 'preview-partial-lark', revision: 1, state: 'active',
    connectionId: connection.config.connectionId, application: connection.config.application, externalConversationId: room.externalConversationId,
    scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' }, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } },
  { ...target, bindingId: 'preview-whole-discord', revision: 1, state: 'active', connectionId: secondConnection.config.connectionId, application: secondConnection.config.application,
    externalConversationId: '456789012345678901', scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, sourceCheckpoints: [], authorizedBy: { kind: 'user', id: 'preview-person' } }]
  Object.assign(proof, { sharing: { facts: () => ({ bindings: structuredClone(bindings), drafts: structuredClone(useAppStore.getState().connectorRoomDrafts) }) } })
}
if (conversationSync) {
  const pending = { operationId: 'preview-retained-input', runId: session.control.run.runId, text: 'Keep this pending input for explicit send.', status: 'deferred' as const, promptCondition: null, awaitingExplicitSend: true as const, errorCode: 'AGENT_EXECUTION_NOT_REQUESTED' }
  useAppStore.setState({ agentSteerQueues: { [session.id]: [pending] } })
  const reference = { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }, sourceHostId = reference.hostId
  const items: AgentTimelineSnapshot['items'] = [
    { id: 'preview-sharing-request', agentSessionId: reference.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Request', content: 'Please review the research notes and suggest the next step.', publicContent: 'confirmed', authorHuman: true, sourceChannel: 'api', createdAt: 1, updatedAt: 1 },
    { id: 'preview-sharing-reply', agentSessionId: reference.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: 'The notes are ready to review. We can compare the open questions next.', createdAt: 2, updatedAt: 2 }
  ]
  const stream = { epoch: 'preview-sharing-stream', revision: 2, sequence: 2, origin: 'beginning' as const, gaps: [], positions: items.map((item, index) => ({ id: item.id, firstSequence: index + 1, sequence: index + 1, revision: conversationRevision(item) })) }
  const projected = projectConversationTimeline({ ...reference, executionHostId: sourceHostId, timeline: { agentSessionId: reference.agentSessionId, sourceHostId, revision: 2, items, stream } })
  const conversation = (input: ConversationTimelineReadInput) => {
    if (input.hostId !== reference.hostId || input.agentSessionId !== reference.agentSessionId) throw Error('The preview cannot read another conversation')
    const checkpoint = { ...reference, sourceHostId, frontier: { ...reference, scope: projected.scope, cuts: [{ kind: 'captured', epoch: stream.epoch, sequence: stream.sequence }] } }
    const items = [...projected.events].reverse().map(event => ({ kind: 'item' as const, item: { event, records: projected.records.filter(record => event.recordIds.includes(record.id)) } }))
    return parseConversationReadPage({ ...reference, sourceHostId, scope: projected.scope, coverage: projected.coverage, ...(input.processDetails ? { processDetails: input.processDetails } : {}), order: { ...projected.order, direction: 'newest-first' }, items, nextCursor: null, budgetBytes: input.maxBytes ?? 65536,
      window: { id: 'preview-sharing-window', revision: 1, itemCount: items.length, complete: true, view: 'preview-sharing-view', replay: 'preview-sharing-replay', checkpoint, outside: { older: null, newer: null }, navigation: { older: null, newer: null } } }, input)
  }
  api.conversation.readAgentConversation = async input => { composerConversationReads.push('readAgentConversation'); return conversation(input) }
  api.conversation.readConversationChanges = async input => { composerConversationReads.push('readConversationChanges'); const page = conversation(input); return { ...page, checkpoint: page.window.checkpoint, more: false } }
  api.conversation.observeConversation = async input => {
    composerConversationReads.push('observeConversation'); const page = conversation(input), closed = new AbortController()
    return { ...reference, sourceHostId, scope: page.scope, coverage: page.coverage, closed: closed.signal, dispose() { closed.abort() } }
  }
  api.conversation.releaseConversationView = async input => ({ ...reference, sourceHostId, viewId: input.view, released: true })
  // Guard the original public input leaves without invoking the preview Agent implementation.
  for (const method of ['write', 'submitPrompt', 'replyQuestion', 'respondInteraction', 'interrupt', 'stopInputWaiting', 'rejoinInputWaiting'] as const) {
    Object.assign(api.sessions, { [method]: async (...args: unknown[]) => { composerWrites.push({ method, args }); throw Error('Composer preview must not write: ' + method) } })
  }
  Object.assign(proof, { conversationSync: {

    setScenario(value: typeof composerScenario) {
      composerScenario = value
      bindings = bindings.map((binding, index) => ({ ...binding, revision: value === 'paused-off' && index === 0 ? 2 : 1, state: value === 'paused-off' && index === 0 ? 'paused' : 'active' }))
      invalidateConnectorTarget(target)
    },
    facts: () => ({ session: structuredClone(session.control), view: useAppStore.getState().viewModes[session.id], pending: structuredClone(useAppStore.getState().agentSteerQueues[session.id]), scenario: composerScenario, bindings: structuredClone(bindings), names: composerNames.slice(), reads: structuredClone(composerReads), writes: composerWrites.slice(), conversationReads: composerConversationReads.slice(),
      conversationKeys: projected.records.map(record => conversationMessageSourceKey(reference.agentSessionId, record.reference!.source)),
      service: Object.entries(useAppStore.getState().connectorServiceObservation).map(([key, value]) => ({ key, state: value.state, issue: value.issue, generation: value.generation, currentSource: value.source === api.connections.call })) })
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
