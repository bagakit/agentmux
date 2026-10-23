import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
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
  connectorRoomIntents: {}, connectorRoomDrafts: {}, connectorServiceIntents: {}, connectorServiceObservation: null })
mountThemeRuntime(window, config.appearance)

// Controlled typed facts only. The real IPC/SDK/binding and App route are proven by the consumer tests.
const connection: ConnectionRecord = { config: { connectionId: 'preview-discord', adapterId: 'discord', application: { domain: 'discord.com', appId: '123456789012345678' },
  label: 'Research discussion', enabled: true, credentialRef: 'preview-secure-reference' }, revision: 1,
  capabilities: { roomDiscovery: true, roomCreation: false, roomLink: true },
  observation: { authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } } }
let bindings: RoomBinding[] = []
const proof = { ready: false, omitOriginal: false, status: 'normal' as 'normal' | 'attention' | 'unavailable', calls: [] as string[], errors: [] as string[] }
const room = { externalConversationId: '345678901234567890', name: 'research-and-engineering', state: 'active' as const, mode: 'group' as const, membershipApproval: 'unknown' as const }
api.connections.call = (async (method: string, input: any) => {
  proof.calls.push(method)
  const subject = { kind: 'conversation', externalConversationId: room.externalConversationId }
  const meta = { connectionId: connection.config.connectionId, connectionRevision: 1, application: connection.config.application,
    entry: { subject, cacheRevision: 'preview-cache', observation: { subject, state: 'observed', freshness: 'current', profile: { name: room.name, observedAt: Date.now() }, checkedAt: Date.now() } } }
  if (method === 'connection.ls') return { connections: proof.omitOriginal ? [] : [connection] }
  if (method === 'connection.inspect') return { connection, operation: null }
  if (method === 'connection.service.get') return { enabled: true, revision: 1 }
  if (method === 'connection.binding.ls') return { bindings }
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
  if (method === 'connection.binding.inspect') return { binding: bindings[0] ?? null, current: bindings[0] ?? null, operation: null, grants: [] }
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
    openChannel: channelOrigin => setRoute({ section: settingsCatalog.channelPresentation(channelOrigin.connection.application, channelOrigin.connection.adapterId)?.section ?? 'overview', channelOrigin })
  }}><WorkspaceWorkbench workspaceId={workspace.id} />
    {route ? <SettingsPanel initialSection={route.section} navigationRequest={route} onClose={() => setRoute(null)} /> : null}
  </SettingsNavigation.Provider></DesktopClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
proof.ready = true
